import { Module } from '@nestjs/common';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenGraceService } from './token-grace.service';
import { TokenGraceWorker } from './token-grace.worker';

/**
 * 认证模块。
 *
 * TenantPrismaService 由 @Global 的 TenancyModule 提供并导出，本模块不重复声明——
 * 重复声明会产生第二个实例（两条连接池），且 app.get() 拿到的与拦截器内部用的
 * 不是同一个。JwtStrategy 直接注入 TenancyModule 导出的实例即可。
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      secret:
        process.env.JWT_SECRET ??
        'change-me-in-production-at-least-32-chars-long',
      // ms 的类型把 expiresIn 收窄成模板字面量类型（如 `${number}h`），
      // 环境变量读出来是普通 string，必须显式转型才能通过编译。
      // 运行时行为不变：ms 照样解析 '2h' 这类写法。
      signOptions: {
        expiresIn: (process.env.JWT_EXPIRES_IN ??
          '2h') as JwtSignOptions['expiresIn'],
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    JwtAuthGuard,
    TokenGraceService,
    TokenGraceWorker,
  ],
  exports: [AuthService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}
