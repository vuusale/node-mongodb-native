#! /usr/bin/env node --unhandled-rejections=strict --enable-source-maps
/* eslint-disable no-console */
const util = require('node:util');
const mdb = require('.');
const { MONGO_CLIENT_EVENTS } = require('./lib/constants');
const { setInterval } = require('timers');

const { MongoClient } = mdb;

util.inspect.defaultOptions.breakLength = 1000;
util.inspect.defaultOptions.colors = true;
util.inspect.defaultOptions.depth = 1000;
util.inspect.defaultOptions.compact = true;
util.inspect.defaultOptions.numericSeparator = true;

const start = performance.now();
setInterval(() => console.log(Math.trunc(performance.now() - start)), 1000).unref();

const clientFactory = options => {
  const client = new MongoClient('mongodb://localhost:27017/', options);
  MONGO_CLIENT_EVENTS.map(en => client.addListener(en, ev => console.log(ev)));
  return client;
};

let client = clientFactory();

const failPoint = {
  configureFailPoint: 'failCommand',

  mode: { times: 3 },
  data: {
    failCommands: 'insert',
    blockConnection: 15000,
    appName: 'failMe'
  }
};

async function main(args) {
  console.log('start');
  await client.db().admin().command(failPoint);
  console.log('failpoint');
  await client.close();
  console.log('new client');
  client = clientFactory({ appName: failPoint.appName });
  const collection = client.db('test_db').collection('test_collection');
  console.log('inserting');
  await collection.insertOne({ a: 2.3 }, { timeoutMS: 10_000 });
  console.log('inserted');
  return await collection.find({ a: 2.3 }).toArray();
}

main(process.argv)
  .then(console.log)
  .catch(console.error)
  .finally(() => client.close());
// node --unhandled-rejections=strict --enable-source-maps script.js
