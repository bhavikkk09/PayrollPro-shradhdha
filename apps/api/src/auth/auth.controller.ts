import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { Request } from 'express';
import { Public } from '../common/decorators';
import { AuthService } from './auth.service';

class LoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(1) password: string;
}
class RefreshDto {
  @IsString() @MinLength(20) refreshToken: string;
}

@ApiTags('Authentication')
@Public()
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  login(@Body() d: LoginDto, @Req() req: Request) {
    return this.auth.login(d.email, d.password, req.ip, req.headers['user-agent']);
  }

  @Post('refresh')
  refresh(@Body() d: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(d.refreshToken, req.ip, req.headers['user-agent']);
  }

  @Post('logout')
  async logout(@Body() d: RefreshDto) {
    await this.auth.logout(d.refreshToken);
    return { ok: true };
  }
}
