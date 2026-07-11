/// <reference types="express" />

declare namespace Express {
  namespace Multer {
    interface File {
      fieldname: string;
      originalname: string;
      encoding: string;
      mimetype: string;
      size: number;
      destination: string;
      filename: string;
      path: string;
      buffer: Buffer;
    }
  }
}

declare module 'multer' {
  import { StorageEngine } from 'multer';
  export function memoryStorage(): any;
  export function diskStorage(opts: any): any;
  export default function multer(opts?: any): any;
}
