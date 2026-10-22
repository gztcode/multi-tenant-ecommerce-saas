import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MediaService } from './media.service';
import { UploadUrlDto } from './dto/upload-url.dto';

@ApiTags('media')
@Controller('media')
@UseGuards(JwtAuthGuard)
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post('upload-url')
  @ApiOperation({ summary: '签发上传凭证（presigned URL）' })
  createUploadUrl(
    @Body() dto: UploadUrlDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.mediaService.createUploadUrl(dto, user.userId);
  }

  @Post(':id/confirm')
  @ApiOperation({ summary: '确认上传完成' })
  confirm(@Param('id') id: string) {
    return this.mediaService.confirm(id);
  }

  @Get()
  @ApiOperation({ summary: '媒体列表' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.mediaService.list(
      page ? Number(page) : 1,
      Math.min(100, pageSize ? Number(pageSize) : 20),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除媒体（软删除）' })
  remove(@Param('id') id: string) {
    return this.mediaService.remove(id);
  }
}
