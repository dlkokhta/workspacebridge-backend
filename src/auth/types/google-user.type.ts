export interface GoogleUser {
  googleId?: string;
  email: string;
  // Whether Google asserts the email address is verified. Sign-in is refused
  // when this is false (see findOrCreateGoogleUser).
  emailVerified: boolean;
  firstName: string;
  lastName: string;
  avatar?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}
