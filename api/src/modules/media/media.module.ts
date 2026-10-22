import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MinioService } from './storage/minio.service';

@Module({
  controllers: [MediaController],
  providers: [MediaService, MinioService],
  exports: [MediaService],
})
export class MediaModule {}
