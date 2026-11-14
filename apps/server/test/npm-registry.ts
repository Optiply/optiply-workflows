// The fake npm registry (M25) moved to @ow/code-executor/testing (M37: its builder tests serve it to containers).
export {
  startTestRegistry,
  type TestNpmPackage as TestPackage,
  type TestRegistry,
} from '@ow/code-executor/testing'
