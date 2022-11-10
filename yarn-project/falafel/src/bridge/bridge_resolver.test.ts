import { Blockchain } from '@aztec/barretenberg/blockchain';
import { BridgeCallData } from '@aztec/barretenberg/bridge_call_data';
import { BridgeConfig } from '@aztec/barretenberg/rollup_provider';
import { BridgeResolver } from './bridge_resolver.js';
import { jest } from '@jest/globals';

const bridgeConfigs: BridgeConfig[] = [
  {
    bridgeAddressId: 1,
    numTxs: 5,
    gas: 500000,
    permittedAssets: [0, 1],
  },
  {
    bridgeAddressId: 2,
    numTxs: 10,
    gas: 0,
    permittedAssets: [1, 2],
  },
  {
    bridgeAddressId: 3,
    numTxs: 10,
    gas: undefined,
    permittedAssets: [1, 2],
  },
];

const minVirtualAssetId = 1 << 29;

const generateSampleBridgeCallDatas = () => {
  return [
    {
      callData: new BridgeCallData(
        bridgeConfigs[0].bridgeAddressId,
        bridgeConfigs[0].permittedAssets[0],
        bridgeConfigs[0].permittedAssets[1],
        undefined,
        undefined,
        1,
      ).toBigInt(),
      index: 0,
    },
    {
      callData: new BridgeCallData(
        bridgeConfigs[1].bridgeAddressId,
        bridgeConfigs[1].permittedAssets[0],
        bridgeConfigs[1].permittedAssets[1],
        undefined,
        undefined,
        1,
      ).toBigInt(),
      index: 1,
    },
    {
      callData: new BridgeCallData(
        bridgeConfigs[0].bridgeAddressId,
        bridgeConfigs[0].permittedAssets[1],
        bridgeConfigs[0].permittedAssets[0],
        undefined,
        undefined,
        1,
      ).toBigInt(),
      index: 0,
    },
    {
      callData: new BridgeCallData(
        bridgeConfigs[1].bridgeAddressId,
        bridgeConfigs[1].permittedAssets[1],
        bridgeConfigs[1].permittedAssets[0],
        undefined,
        undefined,
        1,
      ).toBigInt(),
      index: 1,
    },
    {
      callData: new BridgeCallData(
        bridgeConfigs[0].bridgeAddressId,
        bridgeConfigs[0].permittedAssets[1],
        bridgeConfigs[0].permittedAssets[1],
        undefined,
        undefined,
        1,
      ).toBigInt(),
      index: 0,
    },
    {
      callData: new BridgeCallData(
        bridgeConfigs[1].bridgeAddressId,
        bridgeConfigs[1].permittedAssets[0],
        bridgeConfigs[1].permittedAssets[0],
        undefined,
        undefined,
        1,
      ).toBigInt(),
      index: 1,
    },
    {
      callData: new BridgeCallData(
        bridgeConfigs[0].bridgeAddressId,
        bridgeConfigs[0].permittedAssets[0],
        bridgeConfigs[0].permittedAssets[1],
        bridgeConfigs[0].permittedAssets[0],
        bridgeConfigs[0].permittedAssets[1],
        1,
      ).toBigInt(),
      index: 0,
    },
    {
      callData: new BridgeCallData(
        bridgeConfigs[1].bridgeAddressId,
        bridgeConfigs[1].permittedAssets[0],
        bridgeConfigs[1].permittedAssets[1],
        bridgeConfigs[1].permittedAssets[0],
        bridgeConfigs[1].permittedAssets[1],
        1,
      ).toBigInt(),
      index: 1,
    },
  ];
};

type Mockify<T> = {
  [P in keyof T]: ReturnType<typeof jest.fn>;
};

const DEFAULT_BRIDGE_GAS_LIMIT = 200000;

describe('Bridge Resolver', () => {
  let blockchain: Mockify<Blockchain>;
  let bridgeResolver: BridgeResolver;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});

    blockchain = {
      getBridgeGas: jest.fn((bridgeCallData: bigint) => {
        const fullCallData = BridgeCallData.fromBigInt(bridgeCallData);
        if (bridgeConfigs.find(x => x.bridgeAddressId === fullCallData.bridgeAddressId)) {
          return DEFAULT_BRIDGE_GAS_LIMIT;
        }
        throw new Error(`Failed to retrieve bridge cost for bridge ${bridgeCallData.toString()}`);
      }),
      getBlockchainStatus: jest.fn().mockReturnValue({
        allowThirdPartyContracts: false,
      }),
    } as any;

    bridgeResolver = new BridgeResolver(bridgeConfigs, blockchain as any);
  });

  it('returns correct bridge config', () => {
    const callDatas = generateSampleBridgeCallDatas();
    for (const cd of callDatas) {
      expect(bridgeResolver.getBridgeConfig(cd.callData)).toEqual(bridgeConfigs[cd.index]);
    }
  });

  it('should return undefined if bridge config not found', () => {
    expect(
      bridgeResolver.getBridgeConfig(
        new BridgeCallData(
          5, // invalid bridge address id
          0,
          0,
          0,
          0,
          1,
        ).toBigInt(),
      ),
    ).toEqual(undefined);

    expect(
      bridgeResolver.getBridgeConfig(
        new BridgeCallData(
          1,
          10, // invalid asset id
          0,
          0,
          0,
          1,
        ).toBigInt(),
      ),
    ).toEqual(undefined);

    expect(
      bridgeResolver.getBridgeConfig(
        new BridgeCallData(
          1,
          0,
          10, // invalid asset id
          0,
          0,
          1,
        ).toBigInt(),
      ),
    ).toEqual(undefined);

    expect(
      bridgeResolver.getBridgeConfig(
        new BridgeCallData(
          1,
          0,
          0,
          10, // invalid asset id
          0,
          1,
        ).toBigInt(),
      ),
    ).toEqual(undefined);

    expect(
      bridgeResolver.getBridgeConfig(
        new BridgeCallData(
          1,
          0,
          0,
          0,
          10, // invalid asset id
          1,
        ).toBigInt(),
      ),
    ).toEqual(undefined);
  });

  it('ignores aux data when validating bridge config', () => {
    expect(bridgeResolver.getBridgeConfig(new BridgeCallData(1, 0, 0, 0, 0, 98765).toBigInt())).toEqual(
      bridgeConfigs[0],
    );
  });

  it('ignores virtual assets when validating bridge config', () => {
    expect(
      bridgeResolver.getBridgeConfig(
        new BridgeCallData(
          1,
          1 + minVirtualAssetId, // virtual asset id
          0,
          0,
          0,
          1,
        ).toBigInt(),
      ),
    ).toEqual(bridgeConfigs[0]);

    expect(
      bridgeResolver.getBridgeConfig(
        new BridgeCallData(
          1,
          0,
          2 + minVirtualAssetId, // virtual asset id
          0,
          0,
          1,
        ).toBigInt(),
      ),
    ).toEqual(bridgeConfigs[0]);

    expect(
      bridgeResolver.getBridgeConfig(
        new BridgeCallData(
          1,
          0,
          0,
          3 + minVirtualAssetId, // virtual asset id
          0,
          1,
        ).toBigInt(),
      ),
    ).toEqual(bridgeConfigs[0]);

    expect(
      bridgeResolver.getBridgeConfig(
        new BridgeCallData(
          1,
          0,
          0,
          0,
          4 + minVirtualAssetId, // virtual asset id
          1,
        ).toBigInt(),
      ),
    ).toEqual(bridgeConfigs[0]);
  });

  it('validates non-virtual assets when virtual assets are present', () => {
    expect(
      bridgeResolver.getBridgeConfig(
        new BridgeCallData(
          1,
          10, // invalid asset id
          0,
          0,
          1 + minVirtualAssetId, // virtual asset id
          1,
        ).toBigInt(),
      ),
    ).toEqual(undefined);
  });

  it('returns all bridge configs', () => {
    expect(bridgeResolver.getBridgeConfigs()).toEqual(bridgeConfigs);
  });

  it('returns correct full bridge gas', () => {
    const callDatas = generateSampleBridgeCallDatas();
    for (const cd of callDatas) {
      expect(bridgeResolver.getFullBridgeGas(cd.callData)).toEqual(bridgeConfigs[cd.index].gas);
    }
  });

  it('return full bridge gas from contract if not overridden in config', () => {
    const bd = new BridgeCallData(
      3, // address of bridge that does not override gas value
      1,
      2,
      1,
      2,
      1,
    ).toBigInt();
    expect(bridgeResolver.getFullBridgeGas(bd)).toEqual(DEFAULT_BRIDGE_GAS_LIMIT);
  });

  it('ignores virtual assets to return correct full bridge gas', () => {
    expect(
      bridgeResolver.getFullBridgeGas(
        new BridgeCallData(
          1,
          0,
          0,
          0,
          1 + minVirtualAssetId, // virtual asset id
          1,
        ).toBigInt(),
      ),
    ).toEqual(bridgeConfigs[0].gas);
  });

  it('should throw if requesting full bridge gas for invalid bridge', () => {
    const invalidAddress = new BridgeCallData(
      5, // invalid bridge address id
      0,
      0,
      0,
      0,
      1,
    );
    expect(() => {
      bridgeResolver.getFullBridgeGas(invalidAddress.toBigInt());
    }).toThrow(`Failed to retrieve bridge cost for bridge ${invalidAddress.toBigInt().toString()}`);
    const invalidAsset = new BridgeCallData(1, 10, 0, 0, 0, 1);
    expect(() => {
      bridgeResolver.getFullBridgeGas(invalidAsset.toBigInt());
    }).toThrow(`Failed to retrieve bridge cost for bridge ${invalidAsset.toBigInt().toString()}`);
  });

  it('returns correct single tx gas in the bridge config', () => {
    const callDatas = generateSampleBridgeCallDatas();
    for (const cd of callDatas) {
      expect(bridgeResolver.getMinBridgeTxGas(cd.callData)).toEqual(
        bridgeConfigs[cd.index].gas! / bridgeConfigs[cd.index].numTxs,
      );
    }
  });

  it('should throw if requesting min tx gas for invalid bridge', () => {
    expect(() => {
      bridgeResolver.getMinBridgeTxGas(new BridgeCallData(5, 0, 0, 0, 0, 1).toBigInt());
    }).toThrow('Cannot get gas. Unrecognised DeFi-bridge');
    expect(() => {
      bridgeResolver.getMinBridgeTxGas(new BridgeCallData(0, 10, 0, 0, 0, 1).toBigInt());
    }).toThrow('Cannot get gas. Unrecognised DeFi-bridge');
  });

  it('ignores virtual assets to return correct min bridge gas', () => {
    expect(
      bridgeResolver.getMinBridgeTxGas(
        new BridgeCallData(
          1,
          0,
          0,
          0,
          1 + minVirtualAssetId, // virtual asset id
          1,
        ).toBigInt(),
      ),
    ).toEqual(bridgeConfigs[0].gas! / bridgeConfigs[0].numTxs);
  });
});
