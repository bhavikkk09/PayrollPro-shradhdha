import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { Request } from 'express';
import { AllowPasswordChange, CurrentUser, Public } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { AuthService } from './auth.service';

class LoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(1) @MaxLength(200) password: string;
}
class RefreshDto {
  @IsString() @MinLength(20) refreshToken: string;
}
class ChangePasswordDto {
  @IsString() @MaxLength(200) currentPassword: string;
  @IsString() @MaxLength(200) newPassword: string;
}

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  login(@Body() d: LoginDto, @Req() req: Request) {
    return this.auth.login(d.email, d.password, req.ip, req.headers['user-agent']);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  refresh(@Body() d: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(d.refreshToken, req.ip, req.headers['user-agent']);
  }

  @Public()
  @Post('logout')
  async logout(@Body() d: RefreshDto) {
    await this.auth.logout(d.refreshToken);
    return { ok: true };
  }

  /** Requires a valid session. Also the only route open to a user still on a temporary password. */
  @ApiBearerAuth()
  @AllowPasswordChange()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('change-password')
  change(@CurrentUser() u: AuthUser, @Body() d: ChangePasswordDto, @Req() req: Request) {
    return this.auth.changePassword(u.id, d.currentPassword, d.newPassword, req.ip, req.headers['user-agent']);
  }
}
