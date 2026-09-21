import { UserType } from '@prisma/client';

export interface AuthUser {
  id: string;
  type: UserType;
  consultantId: string | null;
  roles: string[];
  permissions: string[];
  mustChangePassword?: boolean;
}
