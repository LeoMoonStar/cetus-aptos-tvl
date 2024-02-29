import {
  Account,
  AccountAddress,
  Aptos,
  AptosConfig,
  Network,
  MoveResource,
} from "@aptos-labs/ts-sdk";
import axios from "axios";

const config = new AptosConfig({ network: Network.MAINNET });
const aptos = new Aptos(config);
const pools = [
  "0xcd321dbfa787982a38e61973a4645481035fc2a7a528880cd486f9cda027458c",
];
const cetusContract =
  "0xec42a352cc65eca17a9fa85d0fc602295897ed6b8b8af6a6c79ef490eb8f9eba";

interface CoinResourceItemData {
  coin: Coin;
  deposit_events: { counter: number; guid: [string] };
  frozen: boolean;
  withdraw_events: { counter: number; guid: [string] };
}
interface Coin {
  value: string;
}

interface CoinInfo {
  decimals: number;
  name: string;
  supply: {};
  symbol: string;
  price?: number;
}

interface CoinPriceInfo {
  base_symbol: string;
  quote_symbol: string;
  price: string;
}
interface PoolWithCoinInfo {
  coin_a_address: string;
  coin_b_address: string;
  coin_a: Coin;
  coin_b: Coin;
  poolAddress: string;
}
interface FactoryResponse {
  key: {};
  value: string;
}

var allCoins: { [name: string]: CoinInfo } = {};
var coinPrices: { [symbol: string]: CoinPriceInfo } = {};

async function getPools(poolAddress: string): Promise<PoolWithCoinInfo> {
  const contractResources = await aptos.getAccountResources({
    accountAddress: poolAddress,
  });

  // Filter resources to find those that match the pool structure
  const pools = contractResources.filter((resource) =>
    resource.type.includes("pool::Pool<")
  );

  // Map over the filtered pools to structure them according to PoolWithCoinInfo
  const poolsWithCoin: PoolWithCoinInfo[] = pools.map((pool) => {
    const frontIndex = pool.type.indexOf("<");
    const backIndex = pool.type.indexOf(">");
    const tokenPair = pool.type.slice(frontIndex + 1, backIndex);
    const [coinAddress1, coinAddress2] = tokenPair
      .split(",")
      .map((address) => address.trim()); // Trim spaces

    // Assuming coin_a and coin_b's structure from your provided interface and JSON structure
    const coin_a = (pool["data"] as any)["coin_a"];
    const coin_b = (pool["data"] as any)["coin_b"];

    return {
      poolAddress: poolAddress, // Adding poolAddress in case you need it
      coin_a_address: coinAddress1.trim(), // Trim in case there are any leading/trailing spaces
      coin_b_address: coinAddress2.trim(), // Trim in case there are any leading/trailing spaces
      coin_a: {
        value: coin_a?.value || "0", // Provide a default value or handle undefined
      },
      coin_b: {
        value: coin_b?.value || "0", // Provide a default value or handle undefined
      },
    };
  });

  return poolsWithCoin[0];
}

async function getPrice() {
  const resp = await axios.get("https://api.cetus.zone/v2/price");
  const data = resp.data["data"]["prices"];
  data.forEach((price: CoinPriceInfo) => {
    coinPrices[price.base_symbol] = price;
  });
}

async function getCoinInfo(address: string) {
  if (!allCoins.hasOwnProperty(address)) {
    let coinOwnerAddress = address.split("::")[0].trim();
    if (coinOwnerAddress == "0x1") {
      coinOwnerAddress =
        "0x0000000000000000000000000000000000000000000000000000000000000001";
    }
    try {
      const resources = await aptos.getAccountResources({
        accountAddress: coinOwnerAddress,
      });
      const coinInfo = resources.filter((resource) =>
        resource.type.includes("CoinInfo")
      )[0];
      allCoins[address] = coinInfo.data as CoinInfo;
    } catch (error) {
      console.log(address, coinOwnerAddress, coinOwnerAddress.length);
    }
  }
}

function calculateOtherTokenPrice(
  Px: number,
  xRaw: number,
  yRaw: number,
  decimalsX: number,
  decimalsY: number
) {
  const x = xRaw / Math.pow(10, decimalsX);
  const y = yRaw / Math.pow(10, decimalsY);

  return Px * (x / y);
}

async function calculatePoolTVL(pool: PoolWithCoinInfo): Promise<string> {
  const { coin_a_address, coin_b_address, coin_a, coin_b } = pool;

  // Fetch coin info if not already cached
  await Promise.all([getCoinInfo(coin_a_address), getCoinInfo(coin_b_address)]);

  // Extract and calculate token amounts with decimals considered
  const coinAInfo = allCoins[coin_a_address];
  const coinBInfo = allCoins[coin_b_address];
  const coinAAmount =
    parseFloat(coin_a.value) / 10 ** (coinAInfo?.decimals || 0);
  const coinBAmount =
    parseFloat(coin_b.value) / 10 ** (coinBInfo?.decimals || 0);

  // Attempt to calculate token prices based on available price info
  const coinAPrice = coinPrices[coin_a_address]?.price
    ? parseFloat(coinPrices[coin_a_address].price)
    : calculateTokenPriceBasedOnOther(
        coin_b_address,
        coin_b.value,
        coin_a.value,
        coinBInfo,
        coinAInfo
      );
  const coinBPrice = coinPrices[coin_b_address]?.price
    ? parseFloat(coinPrices[coin_b_address].price)
    : calculateTokenPriceBasedOnOther(
        coin_a_address,
        coin_a.value,
        coin_b.value,
        coinAInfo,
        coinBInfo
      );

  // Compute TVL values
  const coinALockValue = coinAPrice * coinAAmount;
  const coinBLockValue = coinBPrice * coinBAmount;

  return (coinALockValue + coinBLockValue).toFixed(6);
}

// Helper function to calculate the price of a token based on the price of another
function calculateTokenPriceBasedOnOther(
  otherCoinAddress: string,
  otherCoinValue: string,
  targetCoinValue: string,
  otherCoinInfo: CoinInfo,
  targetCoinInfo: CoinInfo
): number {
  if (!coinPrices[otherCoinAddress] || !otherCoinInfo || !targetCoinInfo)
    return 0;
  const otherPrice = parseFloat(coinPrices[otherCoinAddress].price);
  return calculateOtherTokenPrice(
    otherPrice,
    parseFloat(otherCoinValue),
    parseFloat(targetCoinValue),
    otherCoinInfo.decimals,
    targetCoinInfo.decimals
  );
}

async function callPoolFactory() {
  const accountAddress =
    "0xa7f01413d33ba919441888637ca1607ca0ddcbfa3c0a9ddea64743aaa560e498";
  const resourceType =
    "0xa7f01413d33ba919441888637ca1607ca0ddcbfa3c0a9ddea64743aaa560e498::factory::Pools";
  const factoryResponse = await aptos.getAccountResource({
    accountAddress,
    resourceType,
  });
  const data = factoryResponse["data"]["data"];
  return data.map((d: FactoryResponse) => d.value);
}

async function main() {
  await getPrice();
  const poolFactoryResponse: [string] = await callPoolFactory();
  const TVLs = [];
  const poolsData = await Promise.all(
    poolFactoryResponse.map((pool) => getPools(pool))
  );

  let totalTvl = 0;

  for (const poolData of poolsData) {
    const TVL = await calculatePoolTVL(poolData);
    const result = {
      pool: poolData.poolAddress,
      tvl: TVL,
    };
    totalTvl = totalTvl + parseFloat(TVL);
    TVLs.push(result);
  }
  console.log("Total TVL for all poos:", totalTvl);
  console.log(TVLs);
}

main();
