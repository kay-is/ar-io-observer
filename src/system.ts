/**
 * AR.IO Observer
 * Copyright (C) 2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import { ArIO, WeightedObserver } from '@ar.io/sdk/node';
import {
  TurboAuthenticatedClient,
  TurboFactory,
  defaultTurboConfiguration,
} from '@ardrive/turbo-sdk/node';
import { ArweaveSigner } from 'arbundles/node';
import Arweave from 'arweave';
import { default as NodeCache } from 'node-cache';
import * as fs from 'node:fs';
import { LmdbCache } from 'warp-contracts-lmdb';
import {
  JWKInterface,
  LogLevel,
  LoggerFactory,
  WarpFactory,
  defaultCacheOptions,
} from 'warp-contracts/mjs';

import { ChainSource, MAX_FORK_DEPTH } from './arweave.js';
import * as config from './config.js';
import { WarpContract } from './contract/warp-contract.js';
import { CachedEntropySource } from './entropy/cached-entropy-source.js';
import { ChainEntropySource } from './entropy/chain-entropy-source.js';
import { CompositeEntropySource } from './entropy/composite-entropy-source.js';
import { RandomEntropySource } from './entropy/random-entropy-source.js';
import { RemoteCacheHostsSource } from './hosts/remote-cache-hosts-source.js';
import { StaticHostsSource } from './hosts/static-hosts-source.js';
import log from './log.js';
import { RandomArnsNamesSource } from './names/random-arns-names-source.js';
import { RemoteCacheArnsNameList } from './names/remote-cache-arns-name-list.js';
import { StaticArnsNameList } from './names/static-arns-name-list.js';
import { Observer } from './observer.js';
import {
  EPOCH_BLOCK_LENGTH,
  EpochHeightSource,
  START_HEIGHT,
} from './protocol.js';
import { ContractReportSink } from './store/contract-report-sink.js';
import { FsReportStore } from './store/fs-report-store.js';
import {
  PipelineReportSink,
  ReportSinkEntry,
} from './store/pipeline-report-sink.js';
import { TurboReportSink } from './store/turbo-report-sink.js';

const REPORT_CACHE_TTL_SECONDS = 60 * 60 * 2.5; // 2.5 hours

const observedGatewayHostList =
  config.OBSERVED_GATEWAY_HOSTS.length > 0
    ? new StaticHostsSource({
        hosts: config.OBSERVED_GATEWAY_HOSTS.map((fqdn) => ({
          fqdn,
          wallet: '<unknown>',
        })),
      })
    : new RemoteCacheHostsSource({
        baseCacheUrl: config.CONTRACT_CACHE_URL,
        contractId: config.CONTRACT_ID,
      });

const chainSource = new ChainSource({
  arweaveBaseUrl: config.ARWEAVE_URL,
});

const networkContract = new ArIO({
  contractTxId: config.CONTRACT_ID,
});

// Attempt to read the start height and epoch block length from the contract - default to constants if it fails
const { epochZeroStartHeight, epochBlockLength } = await networkContract
  .getCurrentEpoch()
  .catch((error: any) => {
    log.error(
      `Unable to get start height from contract cache - using default values`,
      {
        message: error?.message,
        stack: error?.stack,
        startHeight: START_HEIGHT,
        epochBlockLength: EPOCH_BLOCK_LENGTH,
      },
    );
    return {
      epochZeroStartHeight: START_HEIGHT,
      epochBlockLength: EPOCH_BLOCK_LENGTH,
    };
  });

export const epochHeightSelector = new EpochHeightSource({
  heightSource: chainSource,
  epochParams: {
    startHeight: epochZeroStartHeight,
    epochBlockLength,
  },
});

const remoteCacheArnsNameList =
  config.ARNS_NAMES.length > 0
    ? new StaticArnsNameList({
        names: config.ARNS_NAMES,
      })
    : new RemoteCacheArnsNameList({
        baseCacheUrl: config.CONTRACT_CACHE_URL,
        contractId: config.CONTRACT_ID,
      });

const chainEntropySource = new ChainEntropySource({
  arweaveBaseUrl: config.ARWEAVE_URL,
});

const prescribedNamesSource = new RandomArnsNamesSource({
  nameList: remoteCacheArnsNameList,
  entropySource: chainEntropySource,
  numNamesToSource: config.NUM_ARNS_NAMES_TO_OBSERVE_PER_GROUP,
});

const randomEntropySource = new RandomEntropySource();

const cachedEntropySource = new CachedEntropySource({
  entropySource: randomEntropySource,
  cachePath: './data/tmp/observer/entropy',
});

const compositeEntropySource = new CompositeEntropySource({
  sources: [cachedEntropySource, chainEntropySource],
});

const chosenNamesSource = new RandomArnsNamesSource({
  nameList: remoteCacheArnsNameList,
  entropySource: compositeEntropySource,
  numNamesToSource: config.NUM_ARNS_NAMES_TO_OBSERVE_PER_GROUP,
});

export const observer = new Observer({
  observerAddress: config.OBSERVER_WALLET,
  referenceGatewayHost: config.REFERENCE_GATEWAY_HOST,
  epochHeightSource: epochHeightSelector,
  observedGatewayHostList,
  prescribedNamesSource,
  chosenNamesSource,
  gatewayAssessmentConcurrency: config.GATEWAY_ASSESSMENT_CONCURRENCY,
  nameAssessmentConcurrency: config.NAME_ASSESSMENT_CONCURRENCY,
  nodeReleaseVersion: config.AR_IO_NODE_RELEASE,
  entropySource: chainEntropySource,
});

export const reportCache = new NodeCache({
  stdTTL: REPORT_CACHE_TTL_SECONDS,
});

const fsReportStore = new FsReportStore({
  log,
  baseDir: './data/reports',
});

log.info(`Using wallet ${config.OBSERVER_WALLET}`);
export const walletJwk: JWKInterface | undefined = (() => {
  if(config.JWK) {
    try {
      const jwk = JSON.parse(config.JWK);
      log.info('Key loaded from environment');
      return jwk;
    } catch (error: any) {
      log.error('Unable to load key from environment:', {
        message: error.message,
      });
    }
  }

  try {
    log.info('Loading key file...', {
      keyFile: config.KEY_FILE,
    });
    const jwk = JSON.parse(fs.readFileSync(config.KEY_FILE).toString());
    log.info('Key file loaded', {
      keyFile: config.KEY_FILE,
    });
    return jwk;
  } catch (error: any) {
    log.error('Unable to load key file:', {
      message: error.message,
    });
  }

  log.warn('Reports will not be published to Arweave');
  return undefined;
})();

export const turboClient: TurboAuthenticatedClient | undefined = (() => {
  if (walletJwk !== undefined) {
    return TurboFactory.authenticated({
      privateKey: walletJwk,
      ...defaultTurboConfiguration,
    });
  } else {
    return undefined;
  }
})();

const signer =
  walletJwk !== undefined ? new ArweaveSigner(walletJwk) : undefined;

const arweaveURL = new URL(config.ARWEAVE_URL);
export const arweave = new Arweave({
  host: arweaveURL.host,
  port: 443,
  protocol: arweaveURL.protocol.replace(':', ''),
});

export const walletAddress =
  walletJwk !== undefined
    ? await arweave.wallets.jwkToAddress(walletJwk)
    : 'INVALID';

const turboReportSink =
  turboClient && signer
    ? new TurboReportSink({
        log,
        arweave,
        turboClient: turboClient,
        walletAddress: config.OBSERVER_WALLET,
        signer,
      })
    : undefined;

const stores: ReportSinkEntry[] = [];
stores.push({
  name: 'FsReportStore',
  sink: fsReportStore,
});
if (turboReportSink !== undefined) {
  stores.push({
    name: 'TurboReportSink',
    sink: turboReportSink,
  });
}

// Set our warp log level
LoggerFactory.INST.logLevel(config.WARP_LOG_LEVEL as LogLevel);
export const warp = WarpFactory.forMainnet(
  {
    ...defaultCacheOptions,
  },
  true,
  arweave,
).useStateCache(new LmdbCache(defaultCacheOptions));

export const contract =
  walletJwk !== undefined
    ? new WarpContract({
        log,
        wallet: walletJwk,
        warp,
        cacheUrl: config.CONTRACT_CACHE_URL,
        contractId: config.CONTRACT_ID,
      })
    : undefined;

export const warpReportSink =
  contract !== undefined
    ? new ContractReportSink({
        log,
        contract,
        walletAddress: config.OBSERVER_WALLET,
      })
    : undefined;

if (!config.SUBMIT_CONTRACT_INTERACTIONS) {
  log.info(
    'SUBMIT_CONTRACT_INTERACTIONS is false - contract interactions will not be saved',
  );
} else if (warpReportSink === undefined) {
  log.info('Wallet not configured - contract interactions will not be saved');
} else {
  stores.push({
    name: 'WarpReportSink',
    sink: warpReportSink,
  });
}

export const reportSink = new PipelineReportSink({
  log,
  sinks: stores,
});

// Wait for chain stability before saving reports
const START_HEIGHT_START_OFFSET = MAX_FORK_DEPTH;

// Ensure there is enough time to save the report at the end of the epoch. We
// use 2 * MAX_FORK_DEPTH because it allows MAX_FORK_DEPTH blocks (somewhat
// arbitrary but pleasingly symmetric) before we stop attempting to save
// altogether for consistency reasons at the end of the epoch.
const START_HEIGHT_END_OFFSET = 2 * MAX_FORK_DEPTH;

export async function updateAndSaveCurrentReport() {
  try {
    log.info('Generating report...');
    const reportStartTime = Date.now();
    const report = await observer.generateReport();
    log.info(`Report generated in ${Date.now() - reportStartTime}ms`);
    reportCache.set('current', report);
    log.info('Report cached');

    log.info('Getting observers from contract state...');
    // Get selected observers for the current epoch from the contract
    const observers: string[] = await networkContract
      .getPrescribedObservers()
      .then((observers: WeightedObserver[]) => {
        log.info(`Retrieved ${observers.length} observers from contract state`);
        return observers.map(
          (observer: WeightedObserver) => observer.observerAddress,
        );
      })
      .catch((error: any) => {
        log.error('Unable to get observers from contract state:', {
          message: error.message,
          stack: error.stack,
        });
        return [];
      });

    if (observers.length === 0) {
      log.warn('Not saving report - no observers retrieved from the contract');
      return;
    }

    // Save the report after a random block between 50 blocks after the start
    // of the epoch and 100 blocks before the end of the epoch
    const entropy = await compositeEntropySource.getEntropy({
      height: report.epochStartHeight,
    });
    const saveAfterHeight =
      report.epochStartHeight +
      START_HEIGHT_START_OFFSET +
      (entropy.readUInt32BE(0) %
        (epochBlockLength -
          START_HEIGHT_START_OFFSET -
          START_HEIGHT_END_OFFSET));

    const currentHeight = await chainSource.getHeight();

    if (!observers.includes(config.OBSERVER_WALLET)) {
      log.info('Not saving report - not selected as an observer');
    } else if (currentHeight > report.epochEndHeight - MAX_FORK_DEPTH) {
      // Contract state is based on the current height so to avoid potential
      // inconsistencies where we generate a report for one epoch, but get
      // contract state from the next one, we don't save the report if we're
      // within MAX_FORK_DEPTH blocks of the end of the epoch. If users ever
      // need to override this they can use the CLI to manually save the
      // report.
      log.info('Not saving report - too close to end of epoch', {
        currentHeight,
        epochEndHeight: report.epochEndHeight,
      });
    } else if (currentHeight < saveAfterHeight) {
      log.info('Not saving report - save height not reached', {
        currentHeight,
        saveAfterHeight,
      });
    } else {
      reportSink.saveReport({ report });
    }
  } catch (error) {
    log.error('Error generating report', error);
  }
}
