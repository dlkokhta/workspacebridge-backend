export interface GoogleUser {
  googleId?: string;
  email: string;
  firstName: string;
  lastName: string;
  avatar?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}
