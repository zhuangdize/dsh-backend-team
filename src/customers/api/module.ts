/**
 * 客户模块的显式装配（T-05/T-06）。
 *
 * 各端点文件保持可替换、可单测的边界；本文件负责把同一个仓储和当前
 * Principal 注入所有用例，避免默认路由因为缺少 useCase 而返回 500。
 * 生产服务仍可把返回的 app 委托到自己的 HTTP 入口，数据库实现通过
 * CustomerRepository 端口注入，不在这里创建连接或执行迁移。
 */

import type { Clock, CustomerActor } from '../domain/customer.js';
import { createCustomer, customerRecordFromAggregate, type CreateCustomerDraft } from '../application/create-customer.js';
import { getCustomer } from '../application/get-customer.js';
import { listChanges } from '../application/list-changes.js';
import { searchCustomers } from '../application/search-customers.js';
import { updateCustomer } from '../application/update-customer.js';
import type {
  CustomerChangeLogStore,
  CustomerRepository,
} from '../persistence/memory-customer-repository.js';
import {
  createCustomersApp,
  ERROR_CODES,
  HttpApiError,
  type CustomersApp,
  type RequestContext,
  type RouteResult,
} from './app.js';
import {
  CREATE_CUSTOMER_PATH,
  handleCreateCustomer,
  type CreateCustomerInput,
} from './create-customer.js';
import { mountCustomerChangesRoute } from './customer-changes.js';
import { mountCustomerDetailRoute } from './customer-detail.js';
import { mountSearchCustomersRoute } from './search-customers.js';
import { mountUpdateCustomerRoute } from './update-customer.js';

export type CustomerModuleRepository = CustomerRepository & CustomerChangeLogStore;

export interface CustomerPrincipal {
  readonly userId: string;
  readonly displayName?: string | undefined;
  readonly teamId?: string | undefined;
  readonly permissions?: readonly string[] | undefined;
}

export interface CustomerModuleOptions {
  readonly repository: CustomerModuleRepository;
  /** 固定服务身份；多用户服务应使用 resolveActor 从会话解析。 */
  readonly actor?: CustomerActor | undefined;
  readonly resolveActor?: ((context: RequestContext) => CustomerActor | null | undefined) | undefined;
  readonly clock?: Clock | undefined;
  readonly phoneKeyFor?: ((phone: string) => string) | undefined;
  readonly maxBodyBytes?: number | undefined;
}

function principalFromActor(actor: CustomerActor): Record<string, unknown> {
  return { userId: actor.userId, displayName: actor.userId };
}

function actorFromPrincipal(value: unknown): CustomerActor | null {
  if (value === null || typeof value !== 'object') return null;
  const userId = (value as { userId?: unknown }).userId;
  return typeof userId === 'string' && userId.trim() !== '' ? { userId: userId.trim() } : null;
}

function actorFor(context: RequestContext, options: CustomerModuleOptions): CustomerActor {
  const resolved = options.resolveActor !== undefined
    ? options.resolveActor(context)
    : options.actor ?? actorFromPrincipal(context.state.principal);
  if (resolved === null || resolved === undefined || typeof resolved.userId !== 'string' || resolved.userId.trim() === '') {
    throw new HttpApiError(401, ERROR_CODES.UNAUTHENTICATED, '当前会话没有可用的用户身份。');
  }
  return { userId: resolved.userId.trim() };
}

function routeResult(outcome: { status: number; headers: Record<string, string>; body: unknown }): RouteResult {
  return { status: outcome.status, headers: outcome.headers, body: outcome.body };
}

/** 创建一个已装配的客户 API 应用，供宿主直接委托或 loopback 验证。 */
export function createConfiguredCustomersApp(options: CustomerModuleOptions): CustomersApp {
  const app = createCustomersApp({ ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }) });

  // 所有端点共享同一会话解析结果；缺少身份时在路由处理前 fail closed。
  app.use((context) => {
    const actor = actorFor(context, options);
    context.state.principal = principalFromActor(actor);
  });

  app.addRoute('POST', CREATE_CUSTOMER_PATH, async (context) => {
    const actor = actorFor(context, options);
    const principal = principalFromActor(actor);
    const outcome = await handleCreateCustomer(await context.readJson(), {
      requestId: context.requestId,
      principal,
      useCase: async (input: CreateCustomerInput, useCaseContext) => {
        const requestId = typeof useCaseContext.requestId === 'string' ? useCaseContext.requestId : undefined;
        const customer = await createCustomer(input as CreateCustomerDraft, {
          repository: options.repository,
          actor,
          ...(options.clock === undefined ? {} : { domain: { clock: options.clock } }),
          ...(options.phoneKeyFor === undefined ? {} : { phoneKeyFor: options.phoneKeyFor }),
          ...(requestId === undefined ? {} : { requestId }),
        });
        return customerRecordFromAggregate(customer, options.phoneKeyFor);
      },
    });
    return routeResult(outcome);
  });

  mountSearchCustomersRoute(app, {
    useCase: (input) => searchCustomers(input, { repository: options.repository }),
  });
  mountCustomerDetailRoute(app, {
    useCase: (customerId) => getCustomer(customerId, {
      repository: options.repository,
      recentChanges: (id) => options.repository.listChanges(id),
    }),
  });
  mountUpdateCustomerRoute(app, {
    useCase: (input, context) => {
      const requestId = typeof context.requestId === 'string' ? context.requestId : undefined;
      const actor = actorForContextRecord(context, options);
      return updateCustomer(input, {
        repository: options.repository,
        actor,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.phoneKeyFor === undefined ? {} : { phoneKeyFor: options.phoneKeyFor }),
        ...(requestId === undefined ? {} : { requestId }),
      });
    },
  });
  mountCustomerChangesRoute(app, {
    useCase: (customerId, page, pageSize) => listChanges(customerId, page, pageSize, { repository: options.repository }),
  });

  return app;
}

function actorForContextRecord(context: Record<string, unknown>, options: CustomerModuleOptions): CustomerActor {
  const principal = actorFromPrincipal(context.principal);
  if (principal !== null) return principal;
  if (options.actor !== undefined) return options.actor;
  throw new HttpApiError(401, ERROR_CODES.UNAUTHENTICATED, '当前会话没有可用的用户身份。');
}

/** 别名，方便既有装配代码按模块命名调用。 */
export const createCustomersModule = createConfiguredCustomersApp;
