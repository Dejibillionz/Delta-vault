import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import * as bs58 from "bs58";
import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

async function test() {
  const rpcUrl = process.env.HELIUS_RPC_URL;
  console.log("RPC URL:", rpcUrl?.replace(/api-key=.*/, "api-key=HIDDEN"));

  const connection = new Connection(rpcUrl!, "confirmed");

  try {
    // Test 1: Get current slot
    const slot = await connection.getSlot();
    console.log("✓ Slot:", slot);

    // Test 2: Get wallet balance
    let pubkey: PublicKey;
    const keypairPath = process.env.WALLET_KEYPAIR_PATH;
    const base58Key = process.env.WALLET_PRIVATE_KEY_BASE58;

    if (keypairPath && fs.existsSync(keypairPath)) {
      const raw = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
      pubkey = new PublicKey(raw[0]);
    } else if (base58Key) {
      const secretKey = bs58.decode(base58Key);
      pubkey = Keypair.fromSecretKey(secretKey).publicKey;
    } else {
      throw new Error("No wallet configured (keypair.json or WALLET_PRIVATE_KEY_BASE58)");
    }

    const balance = await connection.getBalance(pubkey);
    console.log("✓ Wallet:", pubkey.toBase58());
    console.log("✓ SOL Balance:", balance / 1e9, "SOL");

    // Test 3: Check USDC token account
    const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      pubkey,
      { mint: USDC_MINT }
    );

    if (tokenAccounts.value.length > 0) {
      const usdcBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
      console.log("✓ USDC Balance:", usdcBalance);
    } else {
      console.log("⚠ No USDC token account found");
    }

    console.log("\n✓ All tests passed! Ready for live trading.");

  } catch (e) {
    console.error("✗ Error:", (e as Error).message);
  }
}

test();
