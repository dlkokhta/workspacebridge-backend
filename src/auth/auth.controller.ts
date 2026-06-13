import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
  Res,
  Get,
  Query,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { CookieOptions, Request, Response } from 'express';
import { User } from '@prisma/client';
import { AuthService } from './auth.service';
import { GoogleUser } from './types/google-user.type';
import { TwoFactorAuthService } from './two-factor-auth.service';
import { PasskeyService } from './passkey.service';
import {
  VerifyPasskeyAuthenticationDto,
  VerifyPasskeyRegistrationDto,
} from './dto/passkey.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginUserDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { ChangeEmailDto } from './dto/change-email.dto';
import {
  DisableTwoFactorDto,
  TwoFactorCodeDto,
  VerifyTwoFactorLoginDto,
} from './dto/two-factor.dto';
import { GoogleOAuthGuard } from './guards/google-oauth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CsrfGuard } from './guards/csrf.guard';
import { ApiBody, ApiOperation, ApiTags, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'crypto';
import {
  CSRF_COOKIE,
  REFRESH_COOKIE,
  REMEMBER_ME_TTL_MS,
} from './auth.constants';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly twoFactorAuthService: TwoFactorAuthService,
    private readonly passkeyService: PasskeyService,
    private readonly configService: ConfigService,
  ) {}

  // Short-lived httpOnly cookies that carry the signed WebAuthn challenge from
  // the "options" step to the matching "verify" step. They share the refresh
  // cookie's cross-domain attributes (sameSite/secure) so they survive the
  // same deployments, but live for only 5 minutes.
  private static readonly PK_REG_COOKIE = 'pkRegChallenge';
  private static readonly PK_AUTH_COOKIE = 'pkAuthChallenge';
  private static readonly PK_CHALLENGE_MAX_AGE = 5 * 60 * 1000;

  private setChallengeCookie(res: Response, name: string, token: string): void {
    res.cookie(
      name,
      token,
      this.getRefreshCookieOptions(AuthController.PK_CHALLENGE_MAX_AGE),
    );
  }

  private clearChallengeCookie(res: Response, name: string): void {
    res.clearCookie(name, this.getRefreshCookieOptions());
  }

  // Centralized cookie attributes for the refresh token. Driven by env so
  // cross-domain deployments (frontend on a different eTLD+1 than the API)
  // can use sameSite='none' + secure=true, while same-site deployments
  // can stay on 'strict' or 'lax'. Used by every set/clear call below so
  // the browser actually clears the cookie it previously stored.
  //
  // Defaults:
  //   - production: sameSite='none', secure=true (works cross-domain)
  //   - dev:        sameSite='lax',  secure=false (works on localhost)
  // Override via the COOKIE_SAMESITE env variable.
  private getRefreshCookieOptions(maxAge?: number): CookieOptions {
    const isProduction = process.env.NODE_ENV === 'production';
    const sameSite = (this.configService.get<string>('COOKIE_SAMESITE') ??
      (isProduction ? 'none' : 'lax')) as 'strict' | 'lax' | 'none';
    // sameSite='none' is rejected by browsers unless the cookie is also
    // marked secure, so we force secure=true in that case regardless of
    // NODE_ENV.
    const secure = sameSite === 'none' ? true : isProduction;
    return {
      httpOnly: true,
      secure,
      sameSite,
      path: '/',
      // With maxAge undefined this is a session cookie the browser drops on
      // close; "remember me" passes an explicit 30-day maxAge.
      maxAge,
    };
  }

  // "Remember me" → persistent 30-day cookie; otherwise a session cookie.
  // The server-side cap (30d vs 1d) is enforced by Session.expiresAt.
  private refreshCookieMaxAge(rememberMe?: boolean): number | undefined {
    return rememberMe ? REMEMBER_ME_TTL_MS : undefined;
  }

  // Sets the httpOnly refresh cookie together with the readable CSRF cookie
  // (double-submit pattern, see CsrfGuard). Both share the same lifetime.
  private setAuthCookies(
    res: Response,
    refreshToken: string,
    rememberMe?: boolean,
  ): void {
    const maxAge = this.refreshCookieMaxAge(rememberMe);
    res.cookie(REFRESH_COOKIE, refreshToken, this.getRefreshCookieOptions(maxAge));
    res.cookie(CSRF_COOKIE, randomBytes(32).toString('hex'), {
      ...this.getRefreshCookieOptions(maxAge),
      httpOnly: false,
    });
  }

  private clearAuthCookies(res: Response): void {
    // Match the attributes the cookies were set with so the browser will
    // actually drop them (Chrome/Firefox compare sameSite + secure on clear).
    res.clearCookie(REFRESH_COOKIE, this.getRefreshCookieOptions());
    res.clearCookie(CSRF_COOKIE, {
      ...this.getRefreshCookieOptions(),
      httpOnly: false,
    });
  }

  // Google OAuth Login - Step 1: Redirect to Google
  @Get('google')
  @UseGuards(GoogleOAuthGuard)
  async googleAuth() {
    this.logger.log('Redirecting to Google for authentication');
    // This will redirect to Google
  }

  // Google OAuth Login - Step 2: Handle callback from Google
  @Get('google/callback')
  @UseGuards(GoogleOAuthGuard)
  async googleAuthRedirect(@Req() req: Request, @Res() res: Response) {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL');

    try {
      const googleUser = req.user as unknown as GoogleUser;
      const ip = req.ip;
      const userAgent = req.headers['user-agent'];
      const result = await this.authService.findOrCreateGoogleUser(
        googleUser,
        ip,
        userAgent,
      );

      // The access token never goes through the URL (it would leak via
      // browser history, server logs, Referer header, analytics scripts).
      // Instead we mint a short-lived single-use exchange code that the
      // frontend immediately POSTs to /auth/exchange to get the real tokens.
      // The session row that findOrCreateGoogleUser just created is
      // discarded — /auth/exchange will create a fresh session that the
      // frontend actually holds the refresh token for.
      await this.authService.logout(result.refreshToken);
      const exchangeCode = await this.authService.createExchangeCode(
        result.userExist.id,
      );

      return res.redirect(`${frontendUrl}/auth/success?code=${exchangeCode}`);
    } catch (error) {
      this.logger.error('Google OAuth callback failed', error);
      return res.redirect(`${frontendUrl}/auth/error?error=oauth_failed`);
    }
  }

  @Post('exchange')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary:
      'Exchange a short-lived OAuth code for tokens (sets refresh cookie)',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns user + accessToken; sets refreshToken cookie',
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired code' })
  @ApiResponse({ status: 429, description: 'Too many attempts.' })
  public async exchangeOAuthCode(
    @Body() body: { code: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body?.code || typeof body.code !== 'string') {
      throw new UnauthorizedException('Invalid or expired exchange code');
    }

    const ip = req.ip;
    const userAgent = req.headers['user-agent'];
    const result = await this.authService.exchangeCodeForTokens(
      body.code,
      ip,
      userAgent,
    );

    this.setAuthCookies(res, result.refreshToken, result.rememberMe);

    const { refreshToken: _rt, rememberMe: _rm, ...rest } = result;
    return rest;
  }

  // Get user profile
  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get authenticated user profile' })
  @ApiResponse({ status: 200, description: 'Returns the authenticated user' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getProfile(@Req() req: Request) {
    return req.user;
  }

  @Post('signup')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Register a new user' })
  @ApiBody({ type: CreateUserDto })
  @ApiResponse({
    status: 200,
    description:
      'Generic success message — identical whether the email was new ' +
      '(verification email sent) or already registered (owner notified by ' +
      'email instead). Prevents user enumeration.',
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 429, description: 'Too many attempts. Please try again later.' })
  public async registerUser(@Body() createUserDto: CreateUserDto) {
    return this.authService.registerUser(createUserDto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  // 5 attempts per 5 minutes per IP. Slows distributed brute-force attacks
  // while still leaving room for a legitimate user who fumbles their
  // password a few times.
  @Throttle({ default: { ttl: 300000, limit: 5 } })
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiBody({ type: LoginUserDto })
  @ApiResponse({ status: 200, description: 'Returns accessToken and user info. Sets refreshToken cookie.' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ status: 429, description: 'Too many attempts. Please try again later.' })
  public async loginUser(
    @Body() loginUserDto: LoginUserDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response, // allows Nest to keep sending JSON
  ) {
    const ip = req.ip;
    const userAgent = req.headers['user-agent'];
    const loginResult = await this.authService.loginUser(
      loginUserDto,
      ip,
      userAgent,
    );

    // If 2FA is enabled, return pre-auth token — no cookie yet
    if ('requiresTwoFactor' in loginResult) {
      return loginResult; // { requiresTwoFactor: true, tempToken }
    }

    this.setAuthCookies(res, loginResult.refreshToken, loginResult.rememberMe);

    const { refreshToken: _rt, rememberMe: _rm, ...result } = loginResult;
    return result; // JSON body: { user, accessToken }
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  // Cookie-authenticated endpoint — double-submit CSRF protection. The
  // browser attaches the refresh cookie automatically, so without this a
  // cross-site page could silently rotate the victim's session.
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Refresh access token using refreshToken cookie' })
  @ApiResponse({ status: 200, description: 'Returns new accessToken. Rotates refreshToken cookie.' })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  @ApiResponse({ status: 403, description: 'Invalid or missing CSRF token' })
  public async refreshTokens(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies[REFRESH_COOKIE];
    if (!refreshToken) throw new UnauthorizedException('No refresh token');

    const tokens = await this.authService.refresh(refreshToken);

    this.setAuthCookies(res, tokens.refreshToken, tokens.rememberMe);

    return { accessToken: tokens.accessToken };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  // Cookie-authenticated like refresh — a cross-site page must not be able
  // to forcibly log the victim out (session revocation is a state change).
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Logout and clear refresh token cookie' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  @ApiResponse({ status: 403, description: 'Invalid or missing CSRF token' })
  public async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies[REFRESH_COOKIE];

    if (refreshToken) {
      await this.authService.logout(refreshToken);
    }

    this.clearAuthCookies(res);

    return { message: 'Logged out successfully' };
  }

  @Get('verify-email')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Verify email address with token' })
  @ApiQuery({ name: 'token', required: true })
  @ApiResponse({ status: 200, description: 'Email verified successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  @ApiResponse({ status: 429, description: 'Too many attempts. Please try again later.' })
  public async verifyEmail(@Query('token') token: string) {
    return this.authService.verifyEmail(token);
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  // Sends an email to whatever address is supplied; same generous cap as
  // forgot-password (3 per 15 min per IP) to curb bulk probing/mail abuse.
  @Throttle({ default: { ttl: 900000, limit: 3 } })
  @ApiOperation({ summary: 'Resend the email verification link' })
  @ApiBody({ type: ResendVerificationDto })
  @ApiResponse({
    status: 200,
    description: 'Verification email sent if the account exists and is unverified',
  })
  @ApiResponse({ status: 429, description: 'Too many attempts. Please try again later.' })
  public async resendVerification(@Body() body: ResendVerificationDto) {
    return this.authService.resendVerification(body.email);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  // Password resets are rare for legitimate users; 3 per 15 min per IP is
  // generous for real use and tighter against bulk probing.
  @Throttle({ default: { ttl: 900000, limit: 3 } })
  @ApiOperation({ summary: 'Send password reset email' })
  @ApiBody({ type: ForgotPasswordDto })
  @ApiResponse({ status: 200, description: 'Reset email sent if account exists' })
  @ApiResponse({ status: 429, description: 'Too many attempts. Please try again later.' })
  public async forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.authService.forgotPassword(body.email);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Reset password with token' })
  @ApiBody({ type: ResetPasswordDto })
  @ApiResponse({ status: 200, description: 'Password reset successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  @ApiResponse({ status: 429, description: 'Too many attempts. Please try again later.' })
  public async resetPassword(@Body() body: ResetPasswordDto) {
    return this.authService.resetPassword(body.token, body.password);
  }

  @Post('change-email')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  // Each request sends an email to a user-supplied address; cap it.
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Request an email change (sends confirmation to the new address)',
  })
  @ApiBody({ type: ChangeEmailDto })
  @ApiResponse({ status: 200, description: 'Confirmation link sent to the new email' })
  @ApiResponse({ status: 401, description: 'Password is incorrect' })
  @ApiResponse({ status: 409, description: 'New email already in use' })
  public async changeEmail(@Req() req: Request, @Body() body: ChangeEmailDto) {
    const user = req.user as User;
    return this.authService.requestEmailChange(
      user.id,
      body.newEmail,
      body.password,
    );
  }

  @Get('confirm-email-change')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Confirm an email change from the emailed link' })
  @ApiQuery({ name: 'token', required: true })
  @ApiResponse({ status: 200, description: 'Email address updated' })
  @ApiResponse({ status: 400, description: 'Invalid or expired link' })
  public async confirmEmailChange(@Query('token') token: string) {
    return this.authService.confirmEmailChange(token);
  }

  // ── Two-Factor Authentication ──────────────────────────────────────────────

  @Post('2fa/generate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Generate 2FA secret and QR code' })
  @ApiResponse({ status: 200, description: 'Returns QR code data URL to scan with authenticator app' })
  public async generateTwoFactor(@Req() req: Request) {
    const user = req.user as User;
    return this.twoFactorAuthService.generateAndStoreSecret(user.id, user.email);
  }

  @Post('2fa/enable')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Enable 2FA after scanning QR code' })
  @ApiBody({ type: TwoFactorCodeDto })
  @ApiResponse({ status: 200, description: '2FA enabled successfully' })
  @ApiResponse({ status: 401, description: 'Invalid code' })
  public async enableTwoFactor(@Req() req: Request, @Body() body: TwoFactorCodeDto) {
    const user = req.user as User;
    return this.twoFactorAuthService.enableTwoFactor(user.id, body.code);
  }

  @Post('2fa/disable')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Disable 2FA (requires password re-auth)' })
  @ApiBody({ type: DisableTwoFactorDto })
  @ApiResponse({ status: 200, description: '2FA disabled successfully' })
  @ApiResponse({ status: 401, description: 'Invalid password or code' })
  public async disableTwoFactor(
    @Req() req: Request,
    @Body() body: DisableTwoFactorDto,
  ) {
    const user = req.user as User;
    return this.twoFactorAuthService.disableTwoFactor(
      user.id,
      body.code,
      body.password,
    );
  }

  @Post('2fa/backup-codes/regenerate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  // Same per-IP cap as 2fa/verify — the route accepts a TOTP guess.
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Regenerate 2FA backup codes (requires current TOTP code)' })
  @ApiBody({ type: TwoFactorCodeDto })
  @ApiResponse({ status: 200, description: 'Returns the new set of one-time backup codes' })
  @ApiResponse({ status: 401, description: 'Invalid code' })
  public async regenerateBackupCodes(
    @Req() req: Request,
    @Body() body: TwoFactorCodeDto,
  ) {
    const user = req.user as User;
    return this.twoFactorAuthService.regenerateBackupCodes(user.id, body.code);
  }

  @Post('2fa/verify')
  @HttpCode(HttpStatus.OK)
  // Brute-force protection: 5 attempts per minute per IP. TOTP space is
  // 10^6 codes; without this an attacker with a valid password (and thus
  // a valid 5-minute tempToken) could otherwise try ~300 codes in the
  // global limit, or many more from distributed IPs.
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Verify 2FA code after login to get full access token' })
  @ApiBody({ type: VerifyTwoFactorLoginDto })
  @ApiResponse({ status: 200, description: 'Returns accessToken + sets refreshToken cookie' })
  @ApiResponse({ status: 401, description: 'Invalid code or expired session' })
  @ApiResponse({ status: 429, description: 'Too many attempts. Please try again later.' })
  public async verifyTwoFactor(
    @Body() body: VerifyTwoFactorLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip;
    const userAgent = req.headers['user-agent'];
    const result = await this.twoFactorAuthService.verifyTwoFactorForLogin(
      body.tempToken,
      body.code,
      ip,
      userAgent,
      body.backupCode,
    );

    this.setAuthCookies(res, result.refreshToken, result.rememberMe);

    const { refreshToken: _rt, rememberMe: _rm, ...rest } = result;
    return rest; // { user, accessToken }
  }

  // ── Passkeys (WebAuthn / FIDO2) ─────────────────────────────────────────────

  @Post('passkeys/register/options')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Begin passkey registration — returns WebAuthn creation options',
  })
  @ApiResponse({
    status: 200,
    description: 'PublicKeyCredentialCreationOptions to pass to the browser',
  })
  public async passkeyRegisterOptions(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = req.user as User;
    const { options, challengeToken } =
      await this.passkeyService.generateRegistrationOptions(
        user.id,
        user.email,
      );
    this.setChallengeCookie(res, AuthController.PK_REG_COOKIE, challengeToken);
    return options;
  }

  @Post('passkeys/register/verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Finish passkey registration — verifies and stores the credential',
  })
  @ApiBody({ type: VerifyPasskeyRegistrationDto })
  @ApiResponse({ status: 200, description: 'The newly registered passkey' })
  @ApiResponse({ status: 400, description: 'Registration could not be verified' })
  public async passkeyRegisterVerify(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: VerifyPasskeyRegistrationDto,
  ) {
    const user = req.user as User;
    const result = await this.passkeyService.verifyRegistration(
      user.id,
      user.email,
      body.response,
      req.cookies?.[AuthController.PK_REG_COOKIE] as string | undefined,
      body.name,
      req.ip,
      req.headers['user-agent'],
    );
    this.clearChallengeCookie(res, AuthController.PK_REG_COOKIE);
    return result;
  }

  @Post('passkeys/login/options')
  @HttpCode(HttpStatus.OK)
  // Same per-IP budget as the password login route — this hands out a
  // challenge that anyone can request, so cap it.
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Begin passkey sign-in — returns WebAuthn request options',
  })
  @ApiResponse({
    status: 200,
    description: 'PublicKeyCredentialRequestOptions to pass to the browser',
  })
  public async passkeyLoginOptions(@Res({ passthrough: true }) res: Response) {
    const { options, challengeToken } =
      await this.passkeyService.generateAuthenticationOptions();
    this.setChallengeCookie(res, AuthController.PK_AUTH_COOKIE, challengeToken);
    return options;
  }

  @Post('passkeys/login/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary:
      'Finish passkey sign-in — verifies the assertion and issues a session',
  })
  @ApiBody({ type: VerifyPasskeyAuthenticationDto })
  @ApiResponse({
    status: 200,
    description: 'Returns accessToken + sets refreshToken cookie',
  })
  @ApiResponse({
    status: 401,
    description: 'Passkey not recognised or verification failed',
  })
  public async passkeyLoginVerify(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: VerifyPasskeyAuthenticationDto,
  ) {
    const result = await this.passkeyService.verifyAuthentication(
      body.response,
      req.cookies?.[AuthController.PK_AUTH_COOKIE] as string | undefined,
      !!body.rememberMe,
      req.ip,
      req.headers['user-agent'],
    );
    this.clearChallengeCookie(res, AuthController.PK_AUTH_COOKIE);
    this.setAuthCookies(res, result.refreshToken, result.rememberMe);

    const { refreshToken: _rt, rememberMe: _rm, ...rest } = result;
    return rest; // { user, accessToken }
  }

  @Get('passkeys')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List the current user passkeys' })
  @ApiResponse({
    status: 200,
    description: 'Array of the user registered passkeys',
  })
  public async listPasskeys(@Req() req: Request) {
    const user = req.user as User;
    return this.passkeyService.listPasskeys(user.id);
  }

  @Delete('passkeys/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Remove a registered passkey' })
  @ApiResponse({ status: 200, description: 'Passkey removed' })
  @ApiResponse({ status: 401, description: 'Passkey not found' })
  public async removePasskey(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as User;
    return this.passkeyService.removePasskey(
      user.id,
      id,
      req.ip,
      req.headers['user-agent'],
    );
  }
}
