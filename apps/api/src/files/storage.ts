import { Global, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Where file contents live. Callers only know keys, so the backend can change (S3, GCS, Azure) without touching them. */
export abstract class FileStorage {
  abstract put(key: string, data: Buffer): Promise<void>;
  abstract get(key: string): Promise<Buffer | null>;
  abstract delete(key: string): Promise<void>;
}

/** Default backend: PostgreSQL. Durable across redeploys and covered by the normal database backups. */
@Injectable()
export class DbFileStorage extends FileStorage {
  constructor(private prisma: PrismaService) { super(); }

  async put(key: string, data: Buffer) {
    await this.prisma.fileBlob.create({ data: { key, data: new Uint8Array(data), size: data.length } });
  }
  async get(key: string) {
    const row = await this.prisma.fileBlob.findUnique({ where: { key } });
    return row ? Buffer.from(row.data) : null;
  }
  async delete(key: string) {
    await this.prisma.fileBlob.deleteMany({ where: { key } });
  }
}

@Global()
@Module({ providers: [{ provide: FileStorage, useClass: DbFileStorage }], exports: [FileStorage] })
export class StorageModule {}
