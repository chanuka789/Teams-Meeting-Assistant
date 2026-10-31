// File storage: Railway bucket (S3-compatible) when S3_BUCKET is set, else a local folder for development.

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const bucket = process.env.S3_BUCKET;
const localDir = path.resolve(process.env.LOCAL_STORAGE_DIR || './data/uploads');

const s3 = bucket
  ? new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || 'auto',
      forcePathStyle: process.env.S3_PATH_STYLE === 'true', // Railway buckets use virtual-host URLs
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
      },
    })
  : null;

export const storageKind = s3 ? 'bucket' : 'local';

const localPath = (key) => {
  const p = path.resolve(localDir, key);
  if (!p.startsWith(localDir + path.sep)) throw new Error('Bad storage key');
  return p;
};

export async function putFile(key, buffer, contentType) {
  if (s3) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }));
    return;
  }
  const p = localPath(key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, buffer);
}

// Store a file from disk without reading it into memory (large audio uploads)
export async function putFileFromPath(key, filePath, contentType) {
  if (s3) {
    const { size } = await fs.stat(filePath);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: createReadStream(filePath), ContentLength: size, ContentType: contentType }));
    return;
  }
  const p = localPath(key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.copyFile(filePath, p);
}

// Readable stream of the file
export async function getFileStream(key) {
  if (s3) return (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body;
  return createReadStream(localPath(key));
}

export async function deleteFile(key) {
  if (s3) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return;
  }
  await fs.rm(localPath(key), { force: true });
}

// Write, read back and delete a tiny object, so start-up logs and /health show whether storage works
export async function checkStorage() {
  const key = `health/${Date.now()}.txt`;
  await putFile(key, Buffer.from('ok'), 'text/plain');
  const stream = await getFileStream(key);
  let text = '';
  for await (const chunk of stream) text += chunk;
  await deleteFile(key);
  if (text !== 'ok') throw new Error('read-back mismatch');
}
