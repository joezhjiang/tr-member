import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_BENEFIT_DEFS,
  DEFAULT_BENEFIT_RULES,
  DEFAULT_PLANS,
  DEFAULT_TIERS,
} from '../domain/catalog.js';

function createSeed() {
  return {
    members: [],
    tiers: structuredClone(DEFAULT_TIERS),
    benefitDefs: structuredClone(DEFAULT_BENEFIT_DEFS),
    benefitRules: structuredClone(DEFAULT_BENEFIT_RULES),
    plans: structuredClone(DEFAULT_PLANS),
    orders: [],
    subscriptions: [],
    pointEntries: [],
    benefitGrants: [],
    benefitUsages: [],
  };
}

/**
 * 内存存储 + 可选 JSON 快照落盘。
 * 单进程、同步写入，保证一次请求内的读改写是原子的（Node 单线程即可）。
 * 数据量级为演示/中小规模设计，生产环境应替换为真实数据库。
 */
export function createStore({ snapshotPath = null } = {}) {
  let db = createSeed();

  if (snapshotPath && existsSync(snapshotPath)) {
    const saved = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    db = { ...createSeed(), ...saved };
  }

  function persist() {
    if (!snapshotPath) return;
    mkdirSync(dirname(snapshotPath), { recursive: true });
    const tmpPath = `${snapshotPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(db, null, 2));
    renameSync(tmpPath, snapshotPath);
  }

  return { db, persist };
}
