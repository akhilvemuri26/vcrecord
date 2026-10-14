import test from 'node:test';
import assert from 'node:assert/strict';
import { readTiming, validTiming } from '../src/timing.ts';
test('timing preferences safely restore and reject invalid bounds', () => {
  for (const raw of [null, '', '{', 'null', '{}', '{"preparationSeconds":0,"answerSeconds":20}', '{"preparationSeconds":1.5,"answerSeconds":20}', '{"preparationSeconds":15,"answerSeconds":31}']) assert.deepEqual(readTiming(raw), {preparationSeconds:15,answerSeconds:20});
  assert.deepEqual(readTiming('{"preparationSeconds":1,"answerSeconds":5}'), {preparationSeconds:1,answerSeconds:5});
  for (const value of [{preparationSeconds:NaN,answerSeconds:20},{preparationSeconds:15,answerSeconds:Infinity},{preparationSeconds:121,answerSeconds:20},{preparationSeconds:15,answerSeconds:4}]) assert.equal(validTiming(value),false);
  assert.equal(validTiming({preparationSeconds:120,answerSeconds:30}),true);
});
