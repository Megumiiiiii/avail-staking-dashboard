// Copyright 2023 @paritytech/polkadot-staking-dashboard authors & contributors
// SPDX-License-Identifier: GPL-3.0-only

import { ApiPromise, WsProvider } from '@polkadot/api';
import { ScProvider } from '@polkadot/rpc-provider/substrate-connect';
import { makeCancelable, rmCommas } from '@polkadot-cloud/utils';
import BigNumber from 'bignumber.js';
import { createContext, useContext, useEffect, useState } from 'react';
import { NetworkList, NetworksWithPagedRewards } from 'config/networks';
import {
  FallbackBondingDuration,
  FallbackEpochDuration,
  FallbackExpectedBlockTime,
  FallbackMaxElectingVoters,
  FallbackMaxNominations,
  FallbackSessionsPerEra,
} from 'consts';
import type {
  APIChainState,
  APIConstants,
  APIContextInterface,
  APIProviderProps,
  ApiStatus,
} from 'contexts/Api/types';
import type { AnyApi } from 'types';
import { useEffectIgnoreInitial } from '@polkadot-cloud/react/hooks';
import { signedExtensions, types } from 'avail-js-sdk';
import {
  defaultApiContext,
  defaultChainState,
  defaultConsts,
} from './defaults';

export const APIProvider = ({ children, network }: APIProviderProps) => {
  // Store povider instance.
  const [provider, setProvider] = useState<WsProvider | ScProvider | null>(
    null
  );

  // Store chain state.
  const [chainState, setchainState] =
    useState<APIChainState>(defaultChainState);

  // Store the active RPC provider.
  const initialRpcEndpoint = () => {
    const local = localStorage.getItem(`${network}_rpc_endpoint`);
    if (local)
      if (NetworkList[network].endpoints.rpcEndpoints[local]) {
        return local;
      } else {
        localStorage.removeItem(`${network}_rpc_endpoint`);
      }

    return NetworkList[network].endpoints.defaultRpcEndpoint;
  };
  const [rpcEndpoint, setRpcEndpointState] =
    useState<string>(initialRpcEndpoint());

  // Store whether in light client mode.
  const [isLightClient, setIsLightClient] = useState<boolean>(
    !!localStorage.getItem('light_client')
  );

  // API instance state.
  const [api, setApi] = useState<ApiPromise | null>(null);

  // Store network constants.
  const [consts, setConsts] = useState<APIConstants>(defaultConsts);

  // Store API connection status.
  const [apiStatus, setApiStatus] = useState<ApiStatus>('disconnected');

  // Set RPC provider with local storage and validity checks.
  const setRpcEndpoint = (key: string) => {
    if (!NetworkList[network].endpoints.rpcEndpoints[key]) return;
    localStorage.setItem(`${network}_rpc_endpoint`, key);

    setRpcEndpointState(key);
  };

  // Handle light client connection.
  const handleLightClientConnection = async (Sc: AnyApi) => {
    const newProvider = new ScProvider(
      Sc,
      NetworkList[network].endpoints.lightClient
    );
    connectProvider(newProvider);
  };

  // Handle a switch in API.
  let cancelFn: () => void | undefined;

  const handleApiSwitch = () => {
    setApi(null);
    setConsts(defaultConsts);
    setchainState(defaultChainState);
  };

  // Handle connect to API.
  // Dynamically load `Sc` when user opts to use light client.
  const handleConnectApi = async () => {
    if (api) {
      await api.disconnect();
      setApi(null);
    }
    // handle local light client flag.
    if (isLightClient) {
      localStorage.setItem('light_client', isLightClient ? 'true' : '');
    } else {
      localStorage.removeItem('light_client');
    }

    if (isLightClient) {
      handleApiSwitch();
      setApiStatus('connecting');

      const ScPromise = makeCancelable(import('@substrate/connect'));
      cancelFn = ScPromise.cancel;
      ScPromise.promise.then((Sc) => {
        handleLightClientConnection(Sc);
      });
    } else {
      // if not light client, directly connect.
      setApiStatus('connecting');
      connectProvider();
    }
  };

  // Fetch chain state. Called once `provider` has been initialised.
  const getChainState = async () => {
    if (!provider) return;

    // initiate new api and set connected.
    const newApi = await ApiPromise.create({
      provider,
      // Avail specifics
      noInitWarn: true,
      types,
      signedExtensions,
    });

    // set connected here in case event listeners have not yet initialised.
    setApiStatus('connected');

    const newChainState = await Promise.all([
      newApi.rpc.system.chain(),
      newApi.consts.system.version,
      newApi.consts.system.ss58Prefix,
    ]);

    // check that chain values have been fetched before committing to state.
    // could be expanded to check supported chains.
    if (newChainState.every((c) => !!c?.toHuman())) {
      const chain = newChainState[0]?.toString();
      const version = newChainState[1]?.toJSON();
      const ss58Prefix = Number(newChainState[2]?.toString());

      setchainState({ chain, version, ss58Prefix });
    }

    // store active network in localStorage.
    // NOTE: this should ideally refer to above `chain` value.
    localStorage.setItem('network', String(network));

    // Assume chain state is correct and bootstrap network consts.
    connectedCallback(newApi);
  };

  // Connection callback. Called once `provider` and `api` have been initialised.
  const connectedCallback = async (newApi: ApiPromise) => {
    const allPromises = [
      newApi.consts.staking.bondingDuration,
      newApi.consts.staking.maxNominations,
      newApi.consts.staking.sessionsPerEra,
      newApi.consts.electionProviderMultiPhase.maxElectingVoters,
      newApi.consts.babe.expectedBlockTime,
      newApi.consts.babe.epochDuration,
      newApi.consts.balances.existentialDeposit,
      newApi.consts.staking.historyDepth,
      undefined as any, // newApi.consts.fastUnstake.deposit,
      newApi.consts.nominationPools.palletId,
    ];

    // DEPRECATION: Paged Rewards
    //
    // Fetch `maxExposurePageSize` instead of `maxNominatorRewardedPerValidator` for networks that
    // have paged rewards.
    if (NetworksWithPagedRewards.includes(network)) {
      allPromises.push(newApi.consts.staking.maxExposurePageSize);
    } else {
      allPromises.push(newApi.consts.staking.maxNominatorRewardedPerValidator);
    }

    // fetch constants.
    const result = await Promise.all(allPromises);

    // format constants.
    const bondDuration = result[0]
      ? new BigNumber(rmCommas(result[0].toString()))
      : FallbackBondingDuration;

    const maxNominations = result[1]
      ? new BigNumber(rmCommas(result[1].toString()))
      : FallbackMaxNominations;

    const sessionsPerEra = result[2]
      ? new BigNumber(rmCommas(result[2].toString()))
      : FallbackSessionsPerEra;

    const maxElectingVoters = result[3]
      ? new BigNumber(rmCommas(result[3].toString()))
      : FallbackMaxElectingVoters;

    const expectedBlockTime = result[4]
      ? new BigNumber(rmCommas(result[4].toString()))
      : FallbackExpectedBlockTime;

    const epochDuration = result[5]
      ? new BigNumber(rmCommas(result[5].toString()))
      : FallbackEpochDuration;

    const existentialDeposit = result[6]
      ? new BigNumber(rmCommas(result[6].toString()))
      : new BigNumber(0);

    const historyDepth = result[7]
      ? new BigNumber(rmCommas(result[7].toString()))
      : new BigNumber(0);

    const fastUnstakeDeposit = result[8]
      ? new BigNumber(rmCommas(result[8].toString()))
      : new BigNumber(0);

    const poolsPalletId = result[9] ? result[9].toU8a() : new Uint8Array(0);

    const maxExposurePageSize = result[10]
      ? new BigNumber(rmCommas(result[10].toString()))
      : NetworkList[network].maxExposurePageSize;

    setConsts({
      bondDuration,
      maxNominations,
      sessionsPerEra,
      maxExposurePageSize,
      historyDepth,
      maxElectingVoters,
      epochDuration,
      expectedBlockTime,
      poolsPalletId,
      existentialDeposit,
      fastUnstakeDeposit,
    });
    setApi(newApi);
  };

  // Connect function sets provider and updates active network.
  const connectProvider = async (lc?: ScProvider) => {
    const newProvider =
      lc ||
      new WsProvider(NetworkList[network].endpoints.rpcEndpoints[rpcEndpoint]);
    if (lc) {
      await newProvider.connect();
    }
    setProvider(newProvider);
  };

  // Handle an initial RPC connection.
  useEffect(() => {
    if (!provider && !isLightClient) {
      connectProvider();
    }
  });

  // If RPC endpoint changes, and not on light client, re-connect.
  useEffectIgnoreInitial(() => {
    if (!isLightClient) handleConnectApi();
  }, [rpcEndpoint]);

  // Trigger API connection handler on network or light client change.
  useEffect(() => {
    setRpcEndpoint(initialRpcEndpoint());
    handleConnectApi();
    return () => {
      cancelFn?.();
    };
  }, [isLightClient, network]);

  // Initialise provider event handlers when provider is set.
  useEffectIgnoreInitial(() => {
    if (provider) {
      provider.on('connected', () => {
        setApiStatus('connected');
      });
      provider.on('error', () => {
        setApiStatus('disconnected');
      });
      getChainState();
    }
  }, [provider]);

  return (
    <APIContext.Provider
      value={{
        api,
        consts,
        chainState,
        apiStatus,
        isLightClient,
        setIsLightClient,
        rpcEndpoint,
        setRpcEndpoint,
        isReady: apiStatus === 'connected' && api !== null,
      }}
    >
      {children}
    </APIContext.Provider>
  );
};

export const APIContext = createContext<APIContextInterface>(defaultApiContext);

export const useApi = () => useContext(APIContext);
