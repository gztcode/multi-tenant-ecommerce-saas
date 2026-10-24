import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  HttpException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AddressService } from './address.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';

/**
 * 消费者地址簿。
 *
 * 整组挂 JwtAuthGuard：地址簿是**登录消费者**的私有数据，
 * 游客没有地址簿这回事。匿名访问直接 401。
 */
@ApiTags('addresses')
@Controller('addresses')
@UseGuards(JwtAuthGuard)
export class AddressController {
  constructor(private readonly addressService: AddressService) {}

  @Get()
  @ApiOperation({ summary: '地址簿列表' })
  async list(@Req() request: Request) {
    return this.addressService.list(this.currentCustomerId(request));
  }

  @Post()
  @ApiOperation({ summary: '新增地址' })
  async create(@Body() dto: CreateAddressDto, @Req() request: Request) {
    const customerId = this.currentCustomerId(request);
    // 护栏 20：地址的 customerId 必须属于当前租户。
    // Address 刻意不声明 tenant 关系（外键不带 tenantId，数据库挡不住跨租户挂载），
    // 这里显式查一次归属。
    await this.addressService.assertCustomerInTenant(customerId);
    return this.addressService.create(customerId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '修改地址' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAddressDto,
    @Req() request: Request,
  ) {
    return this.addressService.update(this.currentCustomerId(request), id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除地址（软删）' })
  async remove(@Param('id') id: string, @Req() request: Request) {
    await this.addressService.remove(this.currentCustomerId(request), id);
  }

  /** 当前登录消费者 id */
  private currentCustomerId(request: Request): string {
    const user = (request as Request & { user?: { userId: string } }).user;
    if (!user) {
      throw new HttpException('需要登录后访问', 401);
    }
    return user.userId;
  }
}
