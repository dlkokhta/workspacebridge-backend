import { Injectable, NotImplementedException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface UploadParams {
  workspaceId: string;
  userId: string;
  userRole: UserRole;
  file: Express.Multer.File;
}

@Injectable()
export class FileService {
  constructor(private readonly prisma: PrismaService) {}

  list(_workspaceId: string, _userId: string, _userRole: UserRole) {
    throw new NotImplementedException();
  }

  upload(_params: UploadParams) {
    throw new NotImplementedException();
  }

  getDownloadUrl(_fileId: string, _userId: string, _userRole: UserRole) {
    throw new NotImplementedException();
  }

  remove(_fileId: string, _userId: string, _userRole: UserRole) {
    throw new NotImplementedException();
  }
}
