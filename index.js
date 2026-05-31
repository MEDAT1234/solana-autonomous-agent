#!/usr/bin/env node

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount } = require('@solana/spl-token');
const axios = require('axios');
const fs = require('fs');

// ============================================
// تكوين شبكة Solana Devnet
// ============================================
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
let wallet;
const WALLET_FILE = 'wallet.json';

// تحميل أو إنشاء محفظة
if (fs.existsSync(WALLET_FILE)) {
    const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8')));
    wallet = Keypair.fromSecretKey(secretKey);
    console.log('✅ Loaded wallet:', wallet.publicKey.toString());
} else {
    wallet = Keypair.generate();
    fs.writeFileSync(WALLET_FILE, JSON.stringify(Array.from(wallet.secretKey)));
    console.log('🆕 New wallet created:', wallet.publicKey.toString());
    console.log('💾 Saved to wallet.json (keep secret!)');
}

// ============================================
// وظائف مساعدة (airdrop مع retry، رصيد، swap)
// ============================================
async function requestAirdrop(retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`🔄 Airdrop attempt ${i+1} of ${retries}...`);
            const sig = await connection.requestAirdrop(wallet.publicKey, LAMPORTS_PER_SOL);
            await connection.confirmTransaction(sig);
            console.log('✅ Airdrop successful');
            return;
        } catch (err) {
            console.log(`❌ Attempt ${i+1} failed: ${err.message}`);
            if (i < retries-1) await new Promise(r => setTimeout(r, 5000));
            else throw new Error('Airdrop failed after retries');
        }
    }
}

async function getBalance() {
    const bal = await connection.getBalance(wallet.publicKey);
    return bal / LAMPORTS_PER_SOL;
}

async function ensureBalance(minSOL = 0.05) {
    let bal = await getBalance();
    if (bal < minSOL) {
        console.log(`⚠️ Balance low (${bal} SOL), requesting airdrop...`);
        try {
            await requestAirdrop(3);
            bal = await getBalance();
        } catch (err) {
            console.log(`❌ Airdrop failed. Please manually send SOL to: ${wallet.publicKey.toString()}`);
            throw err;
        }
    }
    return bal;
}

async function executeSwap(amountSOL) {
    try {
        const USDC_MINT = new PublicKey('Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr');
        // Ensure token account exists
        await getOrCreateAssociatedTokenAccount(connection, wallet, USDC_MINT, wallet.publicKey);
        
        const quoteUrl = 'https://quote-api.jup.ag/v6/quote';
        const params = {
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: USDC_MINT.toString(),
            amount: amountSOL * LAMPORTS_PER_SOL,
            slippageBps: 100,
        };
        
        const quoteResp = await axios.get(quoteUrl, { params, timeout: 10000 });
        const quote = quoteResp.data;
        console.log(`📊 Quote: ${quote.inAmount} SOL → ${quote.outAmount} USDC`);
        
        const swapResp = await axios.post('https://quote-api.jup.ag/v6/swap', {
            quoteResponse: quote,
            userPublicKey: wallet.publicKey.toString(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
        }, { timeout: 15000 });
        
        const { swapTransaction } = swapResp.data;
        const txBuf = Buffer.from(swapTransaction, 'base64');
        const tx = VersionedTransaction.deserialize(txBuf);
        tx.sign([wallet]);
        const txid = await connection.sendTransaction(tx);
        await connection.confirmTransaction(txid);
        return { success: true, txid, link: `https://explorer.solana.com/tx/${txid}?cluster=devnet` };
    } catch (err) {
        console.error('Swap error:', err.message);
        return { success: false, error: err.message };
    }
}

// ============================================
// MCP Server (Tools)
// ============================================
const server = new Server(
    { name: "solana-autonomous-agent", version: "2.0.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "get_balance",
            description: "Get SOL balance of the agent's wallet",
            inputSchema: { type: "object", properties: {} }
        },
        {
            name: "send_420_payment",
            description: "Send a simulated 420 protocol payment on Solana",
            inputSchema: {
                type: "object",
                properties: {
                    to: { type: "string", description: "Recipient address" },
                    amount: { type: "number", description: "SOL amount" }
                },
                required: ["to", "amount"]
            }
        },
        {
            name: "swap_sol_to_usdc",
            description: "Swap SOL to USDC on Solana devnet (real swap using Jupiter)",
            inputSchema: {
                type: "object",
                properties: { amount: { type: "number", description: "SOL amount to swap" } },
                required: ["amount"]
            }
        },
        {
            name: "discover_tools_sap",
            description: "List all available tools (Synapse Agent Protocol)",
            inputSchema: { type: "object", properties: {} }
        }
    ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    if (name === "get_balance") {
        const bal = await getBalance();
        return { content: [{ type: "text", text: `💰 Balance: ${bal} SOL` }] };
    }
    
    if (name === "send_420_payment") {
        const txid = `420_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        return { content: [{ type: "text", text: `💸 420 Protocol: Sent ${args.amount} SOL to ${args.to}\nTx: ${txid}` }] };
    }
    
    if (name === "swap_sol_to_usdc") {
        await ensureBalance(args.amount + 0.01);
        const result = await executeSwap(args.amount);
        if (result.success) {
            return { content: [{ type: "text", text: `✅ Swapped ${args.amount} SOL to USDC. TX: ${result.link}` }] };
        } else {
            return { content: [{ type: "text", text: `❌ Swap failed: ${result.error}` }] };
        }
    }
    
    if (name === "discover_tools_sap") {
        return { content: [{ type: "text", text: `🔧 Tools: get_balance, send_420_payment, swap_sol_to_usdc, discover_tools_sap` }] };
    }
    
    throw new Error(`Unknown tool: ${name}`);
});

// ============================================
// تشغيل السيرفر
// ============================================
const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);