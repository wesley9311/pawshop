'use strict';

function productionModules({ redisUrl, fileStorage }) {
  if (typeof redisUrl !== 'string' || !redisUrl) {
    throw new Error('A validated Redis URL is required for production modules.');
  }
  if (!fileStorage?.file_url || !fileStorage?.access_key_id || !fileStorage?.secret_access_key ||
      !fileStorage?.region || !fileStorage?.bucket || !fileStorage?.endpoint) {
    throw new Error('Validated object storage is required for production modules.');
  }
  return [
    {
      resolve: '@medusajs/medusa/file',
      options: {
        providers: [{
          resolve: '@medusajs/medusa/file-s3',
          id: 's3',
          options: fileStorage,
        }],
      },
    },
    {
      resolve: '@medusajs/medusa/caching',
      options: {
        providers: [{
          resolve: '@medusajs/caching-redis',
          id: 'caching-redis',
          is_default: true,
          options: { redisUrl },
        }],
      },
    },
    {
      resolve: '@medusajs/medusa/event-bus-redis',
      options: {
        redisUrl,
        jobOptions: {
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 86400, count: 1000 },
        },
      },
    },
    {
      resolve: '@medusajs/medusa/workflow-engine-redis',
      options: { redis: { redisUrl } },
    },
    {
      resolve: '@medusajs/medusa/locking',
      options: {
        providers: [{
          resolve: '@medusajs/medusa/locking-redis',
          id: 'locking-redis',
          is_default: true,
          options: { redisUrl },
        }],
      },
    },
  ];
}

module.exports = { productionModules };
