import { ConflictError, ForbiddenError, NotFoundError } from '../core/errors.js';
import { hashToken, newId, newToken } from '../core/ids.js';
import {
  oneOf,
  optionalString,
  requireInt,
  requireEmail,
  requireObject,
  requireString,
} from '../core/validate.js';
import { resolveMembership } from '../domain/tierRules.js';

const MEMBER_STATUSES = ['active', 'frozen', 'cancelled'];
const PHONE_PATTERN = /^[0-9+\-\s]{5,30}$/;

export function createMemberService(ctx) {
  const { db, persist, now } = ctx;

  function find(memberId) {
    return db.members.find((member) => member.id === memberId) ?? null;
  }

  function get(memberId) {
    const member = find(memberId);
    if (!member) throw new NotFoundError('会员', memberId);
    return member;
  }

  function register(body) {
    requireObject(body);
    const email = requireEmail(body).toLowerCase();
    const name = requireString(body, 'name', { max: 60 });
    const phone = optionalString(body, 'phone', { max: 30, pattern: PHONE_PATTERN, patternHint: '仅允许数字、+、- 和空格' });

    if (db.members.some((member) => member.email === email)) {
      throw new ConflictError('MEMBER_EMAIL_TAKEN', '该邮箱已注册', { email });
    }

    const token = newToken();
    const timestamp = now();
    const member = {
      id: newId('mem'),
      email,
      name,
      phone: phone ?? null,
      status: 'active',
      growth: 0,
      pointsBalance: 0,
      tokenHash: hashToken(token),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.members.push(member);
    persist();
    return { member, token };
  }

  function findByToken(token) {
    if (!token) return null;
    const hash = hashToken(token);
    return db.members.find((member) => member.tokenHash === hash) ?? null;
  }

  function rotateToken(member) {
    const token = newToken();
    member.tokenHash = hashToken(token);
    member.updatedAt = now();
    persist();
    return token;
  }

  function requireActive(member) {
    if (member.status === 'frozen') {
      throw new ForbiddenError('MEMBER_FROZEN', '会员已被冻结，暂时无法执行该操作');
    }
    if (member.status === 'cancelled') {
      throw new ForbiddenError('MEMBER_CANCELLED', '会员已注销，暂时无法执行该操作');
    }
    return member;
  }

  function addGrowth(member, delta) {
    member.growth = Math.max(0, member.growth + delta);
    member.updatedAt = now();
  }

  function membershipOf(member) {
    return resolveMembership({ tiers: db.tiers, member, subscriptions: db.subscriptions, nowIso: now() });
  }

  function nextTierOf(currentTier, growth) {
    const higher = db.tiers
      .filter((tier) => tier.rank > currentTier.rank)
      .sort((a, b) => a.rank - b.rank)[0];
    if (!higher) return null;
    return {
      code: higher.code,
      name: higher.name,
      growthThreshold: higher.growthThreshold,
      remainingGrowth: Math.max(0, higher.growthThreshold - growth),
    };
  }

  function view(member) {
    const { tier, source, growthTier, subscription } = membershipOf(member);
    return {
      id: member.id,
      email: member.email,
      name: member.name,
      phone: member.phone,
      status: member.status,
      growth: member.growth,
      pointsBalance: member.pointsBalance,
      tier: { code: tier.code, name: tier.name, rank: tier.rank, source },
      growthTier: { code: growthTier.code, name: growthTier.name, rank: growthTier.rank },
      nextTier: nextTierOf(tier, member.growth),
      subscription: subscription
        ? {
            id: subscription.id,
            planId: subscription.planId,
            tierCode: subscription.tierCode,
            endAt: subscription.endAt,
            autoRenew: subscription.autoRenew,
          }
        : null,
      createdAt: member.createdAt,
      updatedAt: member.updatedAt,
    };
  }

  function list({ status, limit = 20, offset = 0 } = {}) {
    const filtered = db.members.filter((member) => (status ? member.status === status : true));
    const page = filtered.slice(offset, offset + limit);
    return { items: page.map(view), total: filtered.length, limit, offset };
  }

  function setStatus(memberId, body) {
    requireObject(body);
    const member = get(memberId);
    const status = oneOf(body, 'status', MEMBER_STATUSES);
    member.status = status;
    member.updatedAt = now();
    persist();
    return member;
  }

  function parsePagination(query) {
    const parse = (raw, fallback, min, max) => {
      if (raw === null) return fallback;
      const value = Number(raw);
      return requireInt({ value }, 'value', { min, max });
    };
    return {
      limit: parse(query.get('limit'), 20, 1, 100),
      offset: parse(query.get('offset'), 0, 0, 100_000),
    };
  }

  return {
    find,
    get,
    register,
    findByToken,
    rotateToken,
    requireActive,
    addGrowth,
    membershipOf,
    view,
    list,
    setStatus,
    parsePagination,
  };
}
