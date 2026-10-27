/**
 * The four canonical watch owners, by family — one leaf per real owner, no generic
 * mutation framework and no Meri-owned watch identity. The constructor asserts the
 * advertised capability matrix never exceeds what the leaves can actually do.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import {
  WATCH_FAMILIES,
  WATCH_SUPPORTED_OPERATIONS,
  type WatchFamily,
  type WatchFamilyAdapter,
} from './watch-action.contract.js';
import { BizdevWatchAdapter } from './bizdev-watch.adapter.js';
import { ClientWatchlistAdapter } from './client-watchlist.adapter.js';
import { DefenseBudgetWatchAdapter } from './defense-budget-watch.adapter.js';
import { KeywordWatchAdapter } from './keyword-watch.adapter.js';

@Injectable()
export class WatchActionRegistry {
  private readonly adapters: ReadonlyMap<WatchFamily, WatchFamilyAdapter>;

  constructor(
    keyword: KeywordWatchAdapter,
    clientWatchlist: ClientWatchlistAdapter,
    bizdev: BizdevWatchAdapter,
    defenseBudget: DefenseBudgetWatchAdapter,
  ) {
    const adapters: Array<WatchFamilyAdapter> = [keyword, clientWatchlist, bizdev, defenseBudget];
    for (const family of WATCH_FAMILIES)
      if (!adapters.some((adapter) => adapter.family === family))
        throw new Error(`watch family ${family} has no owner leaf`);
    for (const adapter of adapters)
      for (const operation of adapter.operations)
        if (!WATCH_SUPPORTED_OPERATIONS[adapter.family].includes(operation))
          throw new Error(`watch leaf ${adapter.family} advertises an unsupported operation`);
    this.adapters = new Map(adapters.map((adapter) => [adapter.family, adapter]));
  }

  adapter(family: WatchFamily): WatchFamilyAdapter {
    const adapter = this.adapters.get(family);
    if (!adapter) throw new BadRequestException('Unsupported watch family');
    return adapter;
  }
}
