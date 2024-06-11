import * as path from 'path';

import { loadSpecTests } from '../../spec';
import { generateTopologyTests, TestRunnerContext } from '../../tools/spec-runner';
import { runUnifiedSuite } from '../../tools/unified-spec-runner/runner';

describe('Retryable Reads (legacy)', function () {
  const testContext = new TestRunnerContext();
  const testSuites = loadSpecTests(path.join('retryable-reads', 'legacy'));

  after(() => testContext.teardown());

  before(function () {
    return testContext.setup(this.configuration);
  });

  generateTopologyTests(testSuites, testContext, spec => {
    const skippedTests = [
      /distinct/i,
      /aggregate/i,
      /countDocuments/i,
      /listIndexes/i,
      /listDatabases/i,
      /listDatabaseNames/i,
      /listCollections/i,
      /listCollectionNames/i,
      /estimatedDocumentCount/i,
      /count/i,
      /find/i
    ];
    if (skippedTests.some(test => test.test(spec.description))) {
      return 'Test skipped by generic filter logic.';
    }
    return true;
  });
});

const UNIMPLEMENTED_APIS = [
  'collection.listIndexNames',
  'database.listCollectionNames',
  'client.listDatabaseNames'
];

describe('Retryable Reads (unified)', function () {
  runUnifiedSuite(loadSpecTests(path.join('retryable-reads', 'unified')), ({ description }) => {
    for (const apiName of UNIMPLEMENTED_APIS) {
      if (description.startsWith(apiName)) {
        return `The Node.js Driver does not support ${apiName}`;
      }
    }
    return false;
  });
});
