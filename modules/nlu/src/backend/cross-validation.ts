import { NLU } from 'botpress/sdk'
import _ from 'lodash'
const seedrandom = require('seedrandom')

import Engine2 from './engine2/engine2'
import Utterance, { buildUtteranceBatch } from './engine2/utterance'
import MultiClassF1Scorer, { F1 } from './tools/f1-scorer'
import { BIO } from './typings'

interface CrossValidationResults {
  intents: Dic<F1> //
  slots: F1
}

interface TestSetExample {
  utterance: Utterance
  ctxs: string[]
  labels: {
    intent: string
    slots: string[] // one tag for each tokens
  }
}

type TestSet = TestSetExample[]
type TrainSet = NLU.IntentDefinition[]

const TRAIN_SET_SIZE = 0.8

async function makeIntentTestSet(rawUtts: string[], ctxs: string[], intent: string, lang: string): Promise<TestSet> {
  const utterances = await buildUtteranceBatch(rawUtts, lang, Engine2.tools)
  return utterances.map(utterance => ({
    utterance,
    ctxs,
    labels: {
      intent,
      slots: utterance.tokens.map(t => _.get(t, 'slots.0.name', BIO.OUT) as string)
    }
  }))
}

async function splitSet(language: string, intents: TrainSet): Promise<[TrainSet, TestSet]> {
  const lo = _.runInContext() // so seed is applied
  let testSet: TestSet = []
  const trainSet = (await Promise.map(intents, async i => {
    // split data & preserve distribution
    const nTrain = Math.floor(TRAIN_SET_SIZE * i.utterances[language].length)
    if (nTrain < 3) {
      return // filter out thouse without enough data
    }

    const utterances = lo.shuffle(i.utterances[language])
    const trainUtts = utterances.slice(0, nTrain)
    const iTestSet = await makeIntentTestSet(utterances.slice(nTrain), i.contexts, i.name, language)
    testSet = [...testSet, ...iTestSet]

    return {
      ...i,
      utterances: { [language]: trainUtts }
    }
  })).filter(Boolean)

  return [trainSet, testSet]
}

// pass k for k-fold is results are not significant
export async function crossValidate(
  botId: string,
  intents: NLU.IntentDefinition[],
  entities: NLU.EntityDefinition[],
  language: string
): Promise<CrossValidationResults> {
  seedrandom('confusion', { global: true })

  const [trainSet, testSet] = await splitSet(language, intents)

  const engine = new Engine2(language, botId)
  await engine.train(trainSet, entities, language)

  const allCtx = _.chain(intents)
    .flatMap(i => i.contexts)
    .uniq()
    .value()

  const intentF1Scorers: Dic<MultiClassF1Scorer> = _.chain(allCtx)
    .thru(ctxs => (ctxs.length > 1 ? ['all', ...ctxs] : ctxs))
    .reduce((byCtx, ctx) => ({ ...byCtx, [ctx]: new MultiClassF1Scorer() }), {})
    .value()

  const slotsF1Scorer = new MultiClassF1Scorer()

  for (const ex of testSet) {
    for (const ctx of ex.ctxs) {
      const res = await engine.predict(ex.utterance.toString(), [ctx])
      intentF1Scorers[ctx].record(res.intent.name, ex.labels.intent)
    }

    const res = await engine.predict(ex.utterance.toString(), allCtx)
    if (allCtx.length > 1) {
      intentF1Scorers['all'].record(res.intent.name, ex.labels.intent)
    }
    const extractedSlots = _.values(res.slots)
    for (const tok of ex.utterance.tokens) {
      const actual = _.get(
        extractedSlots.find(s => s.start <= tok.offset && s.end >= tok.offset + tok.value.length),
        'name',
        BIO.OUT
      ) as string
      const expected = _.get(tok, 'slots.0.name', BIO.OUT) as string
      slotsF1Scorer.record(actual, expected)
    }
  }

  seedrandom()
  return {
    intents: _.fromPairs(_.toPairs(intentF1Scorers).map(([ctx, scorer]) => [ctx, scorer.getResults()])),
    slots: slotsF1Scorer.getResults()
  }
}
