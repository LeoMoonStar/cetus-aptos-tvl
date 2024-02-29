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
  coin_a: {
    value: string;
  };
  coin_b: { value: string };
  poolAddress: string;
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

async function calculatePoolTVL(pool: PoolWithCoinInfo) {
  const { coin_a_address, coin_b_address, coin_a, coin_b } = pool;
  const coin_a_value = coin_a["value"];
  const coin_b_value = coin_b["value"];
  let coin_a_in_coinPrices = coinPrices[coin_a_address];
  let coin_b_in_coinPrices = coinPrices[coin_b_address];
  await getCoinInfo(coin_a_address);
  await getCoinInfo(coin_b_address);
  const coin_a_amount =
    parseFloat(coin_a_value) / 10 ** (allCoins[coin_a_address]?.decimals || 0);
  const coin_b_amount =
    parseFloat(coin_b_value) / 10 ** (allCoins[coin_b_address]?.decimals || 0);
  if (coin_a_in_coinPrices == undefined && coin_b_in_coinPrices == undefined) {
    return 0;
  } else if (coin_a_in_coinPrices == undefined) {
    const coin_a_price = calculateOtherTokenPrice(
      parseFloat(coin_b_in_coinPrices.price),
      parseFloat(coin_b_value),
      parseFloat(coin_a_value),
      allCoins[coin_b_address].decimals,
      allCoins[coin_a_address].decimals
    ).toString();
    coinPrices[coin_a_address] = {
      base_symbol: coin_a_address,
      quote_symbol: "USD",
      price: coin_a_price,
    };
    coin_a_in_coinPrices = coinPrices[coin_a_address];
  } else {
    const coin_b_price = calculateOtherTokenPrice(
      parseFloat(coin_a_in_coinPrices.price),
      parseFloat(coin_a_value),
      parseFloat(coin_b_value),
      allCoins[coin_a_address].decimals,
      allCoins[coin_b_address].decimals
    ).toString();
    coinPrices[coin_b_address] = {
      base_symbol: coin_b_address,
      quote_symbol: "USD",
      price: coin_b_price,
    };
    coin_b_in_coinPrices = coinPrices[coin_b_address];
  }
  const coin_a_lock_value =
    parseFloat(coin_a_in_coinPrices.price) * coin_a_amount;
  const coin_b_lock_value =
    parseFloat(coin_b_in_coinPrices.price) * coin_b_amount;
  return (coin_a_lock_value + coin_b_lock_value).toFixed(6);
}

interface FactoryResponse {
  key: {};
  value: string;
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

  for (const poolData of poolsData) {
    const TVL = await calculatePoolTVL(poolData);
    const result = {
      pool: poolData.poolAddress,
      tvl: TVL,
    };
    TVLs.push(result);
  }
  console.log(TVLs);
}

main();
