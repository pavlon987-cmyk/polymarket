import { ethers } from "ethers";
import { createL2Headers } from "@polymarket/clob-client";

export const CTF_EXCHANGE_V2 = "0xE111180000d2663C0091e4f400237545B87B996B";
export const NEGRISK_EXCHANGE_V2 = "0xe2222d279d744050d28e00520010520000310F59";
export const BYTES32_ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

const ORDER_TYPE_STRING =
  "Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)";
const SOLADY_TYPE_STRING = `TypedDataSign(Order contents,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)${ORDER_TYPE_STRING}`;
const DOMAIN_TYPE_STRING = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

const ORDER_TYPE_HASH = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(ORDER_TYPE_STRING));
const DOMAIN_TYPE_HASH = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(DOMAIN_TYPE_STRING));
const SOLADY_TYPE_HASH = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(SOLADY_TYPE_STRING));
const DEPOSIT_WALLET_NAME_HASH = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("DepositWallet"));
const DEPOSIT_WALLET_VERSION_HASH = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("1"));
const CTF_EXCHANGE_NAME_HASH = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("Polymarket CTF Exchange"));
const CTF_EXCHANGE_VERSION_HASH = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("2"));
const DEPOSIT_WALLET_DOMAIN_SALT = BYTES32_ZERO;

export interface RoundConfig {
  price: number;
  size: number;
  amount: number;
}

export const ROUNDING_CONFIG: Record<string, RoundConfig> = {
  "0.1": { price: 1, size: 2, amount: 3 },
  "0.01": { price: 2, size: 2, amount: 4 },
  "0.005": { price: 3, size: 2, amount: 5 },
  "0.0025": { price: 4, size: 2, amount: 6 },
  "0.001": { price: 3, size: 2, amount: 5 },
  "0.0001": { price: 4, size: 2, amount: 6 },
};

function getDomainSeparator(verifyingContract: string, chainId = 137): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32", "bytes32", "bytes32", "uint256", "address"],
      [DOMAIN_TYPE_HASH, CTF_EXCHANGE_NAME_HASH, CTF_EXCHANGE_VERSION_HASH, chainId, verifyingContract]
    )
  );
}

const negRiskCache = new Map<string, boolean>();
const tickSizeCache = new Map<string, string>();

export async function isNegRiskToken(host: string, tokenId: string): Promise<boolean> {
  if (negRiskCache.has(tokenId)) return negRiskCache.get(tokenId)!;
  try {
    const res = await fetch(`${host}/neg-risk?token_id=${tokenId}`, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      const val = Boolean(data.neg_risk);
      negRiskCache.set(tokenId, val);
      return val;
    }
  } catch {
    // fallback to false
  }
  return false;
}

export async function getTokenTickSize(host: string, tokenId: string): Promise<string> {
  if (tickSizeCache.has(tokenId)) return tickSizeCache.get(tokenId)!;
  try {
    const res = await fetch(`${host}/tick-size?token_id=${tokenId}`, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      const val = String(data.minimum_tick_size || "0.01");
      tickSizeCache.set(tokenId, val);
      return val;
    }
  } catch {
    // fallback
  }
  return "0.01";
}

function roundDown(val: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor(val * factor) / factor;
}

export interface ApiCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export interface ClobV2OrderArgs {
  host: string;
  chainId?: number;
  signer: ethers.Wallet;
  funder: string;
  creds: ApiCreds;
  tokenId: string;
  side: "BUY" | "SELL";
  amount: number; // For BUY: USD; For SELL: shares
  price: number;
  orderType?: "FOK" | "GTC";
}

export interface ClobV2OrderResult {
  ok: boolean;
  orderId?: string;
  status?: string;
  takingAmount?: string;
  makingAmount?: string;
  transactionsHashes?: string[];
  error?: string;
}

export async function executeClobV2Order(args: ClobV2OrderArgs): Promise<ClobV2OrderResult> {
  const {
    host,
    chainId = 137,
    signer,
    funder,
    creds,
    tokenId,
    side,
    amount,
    price,
    orderType = "FOK",
  } = args;

  const negRisk = await isNegRiskToken(host, tokenId);
  const verifyingContract = negRisk ? NEGRISK_EXCHANGE_V2 : CTF_EXCHANGE_V2;
  const domainSeparator = getDomainSeparator(verifyingContract, chainId);

  const tickSize = await getTokenTickSize(host, tokenId);
  const roundCfg = ROUNDING_CONFIG[tickSize] || ROUNDING_CONFIG["0.01"];

  const rawPrice = roundDown(price, roundCfg.price);
  if (rawPrice <= 0) {
    return { ok: false, error: `Недопустимая цена: ${price}` };
  }

  let makerAmtRaw = 0;
  let takerAmtRaw = 0;
  let contractSide = 0;

  if (side === "BUY") {
    contractSide = 0;
    makerAmtRaw = roundDown(amount, roundCfg.size); // USD
    takerAmtRaw = roundDown(makerAmtRaw / rawPrice, roundCfg.amount); // shares
  } else {
    contractSide = 1;
    makerAmtRaw = roundDown(amount, roundCfg.size); // shares
    takerAmtRaw = roundDown(makerAmtRaw * rawPrice, roundCfg.amount); // USD
  }

  const makerAmountStr = Math.round(makerAmtRaw * 1e6).toString();
  const takerAmountStr = Math.round(takerAmtRaw * 1e6).toString();

  const salt = Math.floor(Math.random() * 1000000000000);
  const timestamp = Math.floor(Date.now());
  const signatureType = 3; // Solady POLY_1271

  const contents_hash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "bytes32",
        "uint256",
        "address",
        "address",
        "uint256",
        "uint256",
        "uint256",
        "uint8",
        "uint8",
        "uint256",
        "bytes32",
        "bytes32",
      ],
      [
        ORDER_TYPE_HASH,
        salt,
        funder,
        funder,
        tokenId,
        makerAmountStr,
        takerAmountStr,
        contractSide,
        signatureType,
        timestamp,
        BYTES32_ZERO,
        BYTES32_ZERO,
      ]
    )
  );

  const typed_data_sign_struct_hash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "uint256", "address", "bytes32"],
      [
        SOLADY_TYPE_HASH,
        contents_hash,
        DEPOSIT_WALLET_NAME_HASH,
        DEPOSIT_WALLET_VERSION_HASH,
        chainId,
        funder,
        DEPOSIT_WALLET_DOMAIN_SALT,
      ]
    )
  );

  const digest = ethers.utils.keccak256(
    ethers.utils.concat(["0x1901", domainSeparator, typed_data_sign_struct_hash])
  );

  const signingKey = new ethers.utils.SigningKey(signer.privateKey);
  const sigObj = signingKey.signDigest(digest);
  const innerSignature = ethers.utils.joinSignature(sigObj).slice(2);

  const contents_type = Buffer.from(ORDER_TYPE_STRING, "utf8").toString("hex");
  const contents_type_len = ORDER_TYPE_STRING.length.toString(16).padStart(4, "0");

  const signature =
    "0x" +
    innerSignature +
    domainSeparator.slice(2) +
    contents_hash.slice(2) +
    contents_type +
    contents_type_len;

  const orderPayload = {
    order: {
      salt,
      maker: funder,
      signer: funder,
      tokenId,
      makerAmount: makerAmountStr,
      takerAmount: takerAmountStr,
      side,
      expiration: "0",
      signatureType,
      timestamp: String(timestamp),
      metadata: BYTES32_ZERO,
      builder: BYTES32_ZERO,
      signature,
    },
    owner: creds.key,
    orderType,
    deferExec: false,
    postOnly: false,
  };

  const endpoint = "/order";
  const serialized = JSON.stringify(orderPayload);
  const l2Headers = await createL2Headers(signer as any, creds, {
    method: "POST",
    requestPath: endpoint,
    body: serialized,
  });

  const res = await fetch(`${host}${endpoint}`, {
    method: "POST",
    headers: {
      ...(l2Headers as any),
      "Content-Type": "application/json",
    },
    body: serialized,
  });

  const resText = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(resText);
  } catch {
    return { ok: false, error: `CLOB HTTP ${res.status}: ${resText}` };
  }

  if (res.ok && parsed?.success) {
    return {
      ok: true,
      orderId: String(parsed.orderID || ""),
      status: parsed.status,
      takingAmount: parsed.takingAmount,
      makingAmount: parsed.makingAmount,
      transactionsHashes: parsed.transactionsHashes || [],
    };
  }

  return {
    ok: false,
    orderId: parsed?.orderID ? String(parsed.orderID) : undefined,
    error: parsed?.errorMsg || parsed?.error || `CLOB Error (${res.status}): ${resText}`,
  };
}

export async function cancelClobV2Order(
  host: string,
  signer: ethers.Wallet,
  creds: ApiCreds,
  orderId: string
): Promise<boolean> {
  const cancelPayload = { orderID: orderId };
  const cancelSerialized = JSON.stringify(cancelPayload);
  const endpoint = "/order";

  const cancelHeaders = await createL2Headers(signer as any, creds, {
    method: "DELETE",
    requestPath: endpoint,
    body: cancelSerialized,
  });

  const res = await fetch(`${host}${endpoint}`, {
    method: "DELETE",
    headers: {
      ...(cancelHeaders as any),
      "Content-Type": "application/json",
    },
    body: cancelSerialized,
  });

  return res.ok;
}

export async function syncBalanceAllowance(
  host: string,
  signer: ethers.Wallet,
  creds: ApiCreds
): Promise<boolean> {
  try {
    const endpoint = "/balance-allowance/update";
    const body = JSON.stringify({ asset_type: "COLLATERAL" });
    const headers = await createL2Headers(signer as any, creds, {
      method: "POST",
      requestPath: endpoint,
      body,
    });
    const res = await fetch(`${host}${endpoint}`, {
      method: "POST",
      headers: { ...(headers as any), "Content-Type": "application/json" },
      body,
    });
    return res.ok;
  } catch {
    return false;
  }
}
