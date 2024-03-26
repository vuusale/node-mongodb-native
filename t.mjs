#! /usr/bin/env npx ts-node
/* eslint-disable no-console */

import { env } from 'node:process';
import { inspect } from 'node:util';

import { MongoClient } from './lib/index.js';

const client = new MongoClient(env.MONGODB_URI ?? 'mongodb://iLoveJavaScript', {
  serverSelectionTimeoutMS: 2_000
});

// for (const evName of [
//   'serverHeartbeatStarted',
//   'serverHeartbeatSucceeded',
//   'serverHeartbeatFailed'
// ])
//   client.on(evName, ev =>
//     console.log(inspect(ev, { colors: true, depth: 1000, breakLength: 100000 }))
//   );

async function main() {
  const collection = client.db('test_db').collection('test_collection');
  await collection.insertOne({ a: 2.3 });
  return await collection.find({ a: 2.3 }, { batchSize: 10 }).toArray();
}

main()
  .then(result => console.log({ result }))
  .catch(error => console.error(inspect({ error }, { colors: true, depth: 1000 })))
  .finally(() => client.close());
