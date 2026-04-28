export interface GoogleRequest extends Request {
  user: {
    googleId: string;
    email: string;
    firstname: string;
    lastname: string;
    avatar?: string;
    accessToken?: string;
    refreshToken?: string;
  };
}
