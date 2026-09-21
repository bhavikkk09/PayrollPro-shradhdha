import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { passwordProblems } from '../common/password';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const REFRESH_DAYS = 14;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService, private audit: AuditService) {}

  async login(email: string, password: string, ip?: string, userAgent?: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    const generic = new UnauthorizedException('Invalid email or password');
    if (!user || !user.active) throw generic;
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException('Account temporarily locked. Try again later.');
    }
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      const failed = user.failedLogins + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null },
      });
      await this.audit.log({ userId: user.id, action: 'LOGIN_FAILED', module: 'auth', ip });
      throw generic;
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
    await this.audit.log({ userId: user.id, action: 'LOGIN', module: 'auth', ip });
    return this.issueTokens(user.id, ip, userAgent);
  }

  async refresh(refreshToken: string, ip?: string, userAgent?: string) {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
    if (!row || row.revokedAt || row.expiresAt < new Date()) {
      // Reuse of a revoked token suggests theft: revoke the whole family for that user.
      if (row?.revokedAt) await this.prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw new UnauthorizedException('Invalid refresh token');
    }
    const u = await this.prisma.user.findUnique({ where: { id: row.userId }, select: { active: true } });
    if (!u?.active) throw new UnauthorizedException('Invalid refresh token'); // deactivated users cannot renew
    await this.prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(row.userId, ip, userAgent);
  }

  async logout(refreshToken: string) {
    await this.prisma.refreshToken.updateMany({ where: { tokenHash: sha256(refreshToken), revokedAt: null }, data: { revokedAt: new Date() } });
  }

  /** Works for a normal change and for replacing an admin-issued temporary password. Ends every other session. */
  async changePassword(userId: string, current: string, next: string, ip?: string, userAgent?: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await bcrypt.compare(current, user.passwordHash))) throw new UnauthorizedException('Current password is incorrect');
    if (current === next) throw new BadRequestException('The new password must be different');
    const problems = passwordProblems(next, user.email);
    if (problems.length) throw new BadRequestException({ message: problems.join('. '), errors: problems });
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(next, 12), mustChangePassword: false, failedLogins: 0, lockedUntil: null } }),
      this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.log({ userId, action: 'PASSWORD_CHANGED', module: 'auth', ip });
    return this.issueTokens(userId, ip, userAgent);
  }

  private async issueTokens(userId: string, ip?: string, userAgent?: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
    });
    const roles = user.roles.map((r) => r.role.key);
    const perms = [...new Set(user.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.key)))];
    const accessToken = this.jwt.sign({ sub: user.id, type: user.type, cid: user.consultantId, roles, perms, mcp: user.mustChangePassword });
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.refreshToken.create({
      data: { userId, tokenHash: sha256(refreshToken), expiresAt: new Date(Date.now() + REFRESH_DAYS * 86_400_000), ip, userAgent },
    });
    return {
      accessToken,
      refreshToken,
      user: { id: user.id, name: user.name, email: user.email, type: user.type, roles, permissions: perms, mustChangePassword: user.mustChangePassword },
    };
  }
}
