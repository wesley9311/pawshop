'use strict';

function productionModules({ redisUrl, fileStorage, googleAuth }) {
  if (typeof redisUrl !== 'string' || !redisUrl) {
    throw new Error('A validated Redis URL is required for production modules.');
  }
  if (!fileStorage?.file_url || !fileStorage?.access_key_id || !fileStorage?.secret_access_key ||
      !fileStorage?.region || !fileStorage?.bucket || !fileStorage?.endpoint) {
    throw new Error('Validated object storage is required for production modules.');
  }
  // googleAuth is null while the owner has not provisioned the OAuth client; the
  // auth module then registers emailpass alone (current behaviour). When it is set
  // (validated as a complete triple in production-policy), google is added.
  const authProviders = [
    { resolve: '@medusajs/medusa/auth-emailpass', id: 'emailpass' },
  ];
  if (googleAuth?.clientId && googleAuth?.clientSecret && googleAuth?.callbackUrl) {
    authProviders.push({
      resolve: '@medusajs/medusa/auth-google',
      id: 'google',
      options: {
        clientId: googleAuth.clientId,
        clientSecret: googleAuth.clientSecret,
        callbackUrl: googleAuth.callbackUrl,
      },
    });
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
    {
      // Declaring the auth module overrides the framework default (which registers
      // emailpass alone), so BOTH providers must be listed here or emailpass is
      // dropped. The Google secret never reaches the repository: it arrives through
      // the validated environment, the same path as every other production secret.
      resolve: '@medusajs/medusa/auth',
      options: {
        providers: authProviders,
      },
    },
  ];
}

module.exports = { productionModules };
