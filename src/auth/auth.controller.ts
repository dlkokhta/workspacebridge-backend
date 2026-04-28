import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  Get,
  Query,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { TwoFactorAuthService } from './two-factor-auth.service';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginUserDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { TwoFactorCodeDto, VerifyTwoFactorLoginDto } from './dto/two-factor.dto';
import { GoogleOAuthGuard } from './guards/google-oauth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ApiBody, ApiOperation, ApiTags, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly twoFactorAuthService: TwoFactorAuthService,
    private readonly configService: ConfigService,
  ) {}

  // Google OAuth Login - Step 1: Redirect to Google
  @Get('google')
  @UseGuards(GoogleOAuthGuard)
  async googleAuth() {
    console.log('Redirecting to Google for authentication');
    // This will redirect to Google
  }

  // Google OAuth Login - Step 2: Handle callback from Google
  @Get('google/callback')
  @UseGuards(GoogleOAuthGuard)
  async googleAuthRedirect(@Req() req: Request, @Res() res: Response) {
    try {
      const googleUser = req.user;
      const ip = req.ip;
      const userAgent = req.headers['user-agent'];
      const result = await this.authService.findOrCreateGoogleUser(
        googleUser,
        ip,
        userAgent,
      );

      res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      // Send only the access token to frontend
      const frontendUrl = this.configService.get<string>('FRONTEND_URL');
      return res.redirect(
        `${frontendUrl}/auth/success?token=${result.accessToken}`,
      );
    } catch (error) {
      const frontendUrl = this.configService.get<string>('FRONTEND_URL');
      const errorUrl = `${frontendUrl}/auth/error?status=error&message=${encodeURIComponent(error.message)}`;
      return res.redirect(errorUrl);
    }
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
  @ApiResponse({ status: 200, description: 'User registered. Verification email sent.' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 429, description: 'Too many attempts. Please try again later.' })
  public async registerUser(@Body() createUserDto: CreateUserDto) {
    return this.authService.registerUser(createUserDto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
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

    res.cookie('refreshToken', loginResult.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    const { refreshToken: _rt, ...result } = loginResult;
    return result; // JSON body: { user, accessToken }
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token using refreshToken cookie' })
  @ApiResponse({ status: 200, description: 'Returns new accessToken. Rotates refreshToken cookie.' })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  public async refreshTokens(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies['refreshToken'];
    if (!refreshToken) throw new UnauthorizedException('No refresh token');

    const tokens = await this.authService.refresh(refreshToken);

    res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return { accessToken: tokens.accessToken };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout and clear refresh token cookie' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  public async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies['refreshToken'];

    if (refreshToken) {
      await this.authService.logout(refreshToken);
    }

    res.clearCookie('refreshToken', {
      path: '/',
    });

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

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 3 } })
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

  // ── Two-Factor Authentication ──────────────────────────────────────────────

  @Post('2fa/generate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Generate 2FA secret and QR code' })
  @ApiResponse({ status: 200, description: 'Returns QR code data URL to scan with authenticator app' })
  public async generateTwoFactor(@Req() req: Request) {
    const user = req.user as any;
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
    const user = req.user as any;
    return this.twoFactorAuthService.enableTwoFactor(user.id, body.code);
  }

  @Post('2fa/disable')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Disable 2FA' })
  @ApiBody({ type: TwoFactorCodeDto })
  @ApiResponse({ status: 200, description: '2FA disabled successfully' })
  @ApiResponse({ status: 401, description: 'Invalid code' })
  public async disableTwoFactor(@Req() req: Request, @Body() body: TwoFactorCodeDto) {
    const user = req.user as any;
    return this.twoFactorAuthService.disableTwoFactor(user.id, body.code);
  }

  @Post('2fa/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify 2FA code after login to get full access token' })
  @ApiBody({ type: VerifyTwoFactorLoginDto })
  @ApiResponse({ status: 200, description: 'Returns accessToken + sets refreshToken cookie' })
  @ApiResponse({ status: 401, description: 'Invalid code or expired session' })
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
    );

    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    const { refreshToken: _rt, ...rest } = result;
    return rest; // { user, accessToken }
  }
}
