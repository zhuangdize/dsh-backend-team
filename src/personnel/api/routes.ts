import { createAssignment, retractAssignment } from '../domain/assignment.ts';
import { deletePerson, listPersonHistory } from '../domain/lifecycle.ts';
import { listPersons, getPerson } from '../domain/roster.ts';
import { createPerson, updatePerson } from '../domain/service.ts';
import { transitionPersonStatus } from '../domain/status.ts';
import { requireHrCollection, requireHrPersonResource, personnelErrorResponse, type PersonnelActor } from './access.ts';
import type { PersonnelDatabase } from '../domain/store.ts';

export interface PersonnelRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  actor: PersonnelActor;
  body?: unknown;
  query?: Record<string, string | undefined>;
  requestId?: string;
}

export interface PersonnelResponse {
  status: number;
  body?: unknown;
}

export interface PersonnelRouteOptions {
  idFactory?: () => string;
  clock?: () => string;
  today?: string;
  deleteAuthorized?: boolean;
  isReferenced?: (personId: string) => boolean;
}

function pathParts(path: string): string[] {
  return path.split('?')[0].split('/').filter(Boolean);
}

function numberQuery(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function context(actor: PersonnelActor, options: PersonnelRouteOptions) {
  return {
    operatorId: actor.operatorId,
    operatorName: actor.operatorName,
    idFactory: options.idFactory,
    clock: options.clock,
    today: options.today,
  };
}

export function handlePersonnelRequest(
  db: PersonnelDatabase,
  request: PersonnelRequest,
  options: PersonnelRouteOptions = {},
): PersonnelResponse {
  try {
    const parts = pathParts(request.path);
    if (parts.length === 1 && parts[0] === 'persons') {
      requireHrCollection(request.actor);
      if (request.method === 'GET') {
        const query = request.query ?? {};
        return { status: 200, body: listPersons(db, {
          name: query.name,
          employeeNo: query.employeeNo,
          departmentId: query.departmentId,
          status: query.status as 'draft' | 'active' | 'inactive' | undefined,
          page: numberQuery(query.page, 1),
          pageSize: numberQuery(query.pageSize, 20),
        }) };
      }
      if (request.method === 'POST') {
        return { status: 201, body: createPerson(db, request.body, context(request.actor, options)) };
      }
      throw new Error('unsupported method');
    }

    if (parts[0] !== 'persons' || parts[1] === undefined) return { status: 404, body: { code: 'not_found', message: '资源不存在' } };
    const personId = parts[1];

    if (parts.length === 2) {
      requireHrPersonResource(request.actor);
      if (request.method === 'GET') return { status: 200, body: getPerson(db, personId) };
      if (request.method === 'PATCH') return { status: 200, body: updatePerson(db, personId, request.body, context(request.actor, options)) };
      if (request.method === 'DELETE') {
        deletePerson(db, personId, {
          ...context(request.actor, options),
          deleteAuthorized: options.deleteAuthorized ?? true,
          isReferenced: options.isReferenced,
        });
        return { status: 204 };
      }
      throw new Error('unsupported method');
    }

    requireHrPersonResource(request.actor);
    if (parts[2] === 'assignments' && parts.length === 3 && request.method === 'POST') {
      return { status: 201, body: createAssignment(db, personId, request.body, { ...context(request.actor, options), today: options.today }) };
    }
    if (parts[2] === 'assignments' && parts[3] !== undefined && parts[4] === 'retract' && request.method === 'POST') {
      return { status: 200, body: retractAssignment(db, personId, parts[3], context(request.actor, options)) };
    }
    if (parts[2] === 'status-transitions' && parts.length === 3 && request.method === 'POST') {
      return { status: 200, body: transitionPersonStatus(db, personId, request.body, context(request.actor, options)) };
    }
    if (parts[2] === 'history' && parts.length === 3 && request.method === 'GET') {
      const query = request.query ?? {};
      return { status: 200, body: listPersonHistory(db, personId, numberQuery(query.page, 1), numberQuery(query.pageSize, 20)) };
    }
    return { status: 404, body: { code: 'not_found', message: '资源不存在' } };
  } catch (error) {
    const response = personnelErrorResponse(error, request.requestId);
    return { status: response.status, body: response.body };
  }
}
