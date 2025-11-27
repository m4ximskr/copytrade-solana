import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram, TransactionInstruction,
    TransactionMessage, VersionedTransaction,
    VersionedTransactionResponse,
    ComputeBudgetProgram, TransactionSignature
} from "@solana/web3.js";
import {BorshCoder, Idl} from "@coral-xyz/anchor";
import pumpAmmIdl from "./pump_amm.json";
import WebSocket from "ws";
import Big from "big.js";
import EventEmitter from "events";
import fs from "fs";
import {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
    createAssociatedTokenAccountIdempotentInstruction,
    createSyncNativeInstruction, NATIVE_MINT, createCloseAccountInstruction, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID
} from "@solana/spl-token";

const connection = new Connection('https://mainnet.helius-rpc.com', {
    wsEndpoint: 'wss://https://mainnet.helius-rpc.com',
    commitment: "confirmed"
});

let VALID_BLOCKHASH_SLOT: number;
let VALID_BLOCKHASH: string;
const PUMP_FUN_TOKENS_MAP = new Map<string, string>();

const coder = new BorshCoder(pumpAmmIdl as Idl);

const PUMP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const PUMP_GLOBAL_CONFIG = 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
// const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const EVENT_AUTHORITY = '...';
const GLOBAL_VOLUME_ACCUMULATOR = '...';
const PUMP_FEE_CONFIG = '...';
const PUMP_FEE_PROGRAM = '...';

interface PumpFunAccounts {
    pool: PublicKey,
    user: PublicKey,
    globalConfig: PublicKey,
    baseMint: PublicKey,
    quoteMint: PublicKey,
    userBaseTokenAccount: PublicKey,
    userQuoteTokenAccount: PublicKey,
    poolBaseTokenAccount: PublicKey,
    poolQuoteTokenAccount: PublicKey,
    protocolFeeRecipient: PublicKey,
    protocolFeeRecipientTokenAccount: PublicKey,
    baseTokenProgram: PublicKey,
    quoteTokenProgram: PublicKey,
    systemProgram: PublicKey,
    associatedTokenProgram: PublicKey,
    eventAuthority: PublicKey,
    program: PublicKey,
    coinCreatorVaultAta: PublicKey,
    coinCreatorVaultAuthority: PublicKey,
    globalVolumeAccumulator: PublicKey,
    userVolumeAccumulator: PublicKey,
    feeConfig: PublicKey,
    feeProgram: PublicKey,
}

interface ParsedPumpFunTx {
    signature: string,
    pool: string,
    mint: string,
    price: Big,
    amountOut: Big,
    amountIn: Big,
    swapDirection: 'BUY' | 'SELL',
    data: Object,
    baseTokenProgramId: PublicKey,
}

class WalletListener extends EventEmitter {
    private connection: Connection;
    private walletPubkey: string;
    private subscriptionId: number;

    constructor(connection: Connection, private wallet: string) {
        super();
        this.connection = connection;
        this.walletPubkey = new PublicKey(wallet);
        this.subscriptionId = null;
    }

    start() {
        console.log("Listening for transactions from", this.wallet);

        this.subscriptionId = connection.onLogs(this.walletPubkey, async (log) => {
            // console.log('log', log)
            console.log('NEW EVENT', log.signature)
            console.log('Date.now()', Date.now())

            if (log.err) {
                console.log('LOG ERROR', log.err)
                return;
            }

            const parsedTx = parseTx(log.signature, log.logs);
            // console.log('parsedTx', parsedTx);
            if (!parsedTx) return;

            this.emit('pumpFunSwap', {tx: parsedTx})
        }, "confirmed");
    }

    async stop() {
        console.log('Stopping wallet listener', this.subscriptionId);
        if (this.subscriptionId !== null) {
            try {
                await this.connection.removeOnLogsListener(this.subscriptionId);
                console.log('Successfully unsubscribed');
            } catch (err) {
                console.warn('Failed to unsubscribe cleanly:', err);
            }
            this.subscriptionId = null;
        }
    }

}

class TokenListener extends EventEmitter {
    private connection: Connection;
    private tokenMint: string;
    private initialPrice: string;
    private subscriptionId: number;

    constructor(connection: Connection, tokenMint: string, initialPrice: string) {
        super();
        this.connection = connection;
        this.tokenMint = tokenMint;
        this.initialPrice = initialPrice;
        this.subscriptionId = null;
    }

    start() {
        console.log("Listening for price movements for", this.tokenMint);

        this.subscriptionId = this.connection.onLogs(new PublicKey(this.tokenMint), async (log) => {
            console.log('NEW EVENT', log.signature)
            console.log('Date.now()', Date.now())

            if (log.err) {
                console.log('LOG ERROR', log.err)
                return;
            }

            const parsedTx = parseTx(log.signature, log.logs);
            // console.log('parsedTx', parsedTx);
            if (!parsedTx) return;

            let currentPrice = parsedTx.price;
            if (!this.initialPrice) {
                this.initialPrice = currentPrice;
            }

            const diff = currentPrice.div(this.initialPrice).minus(1).times(100)

            this.emit("priceUpdate", { initialPrice: this.initialPrice, currentPrice, diff, tx: parsedTx });
        }, "confirmed");
    }

    async stop() {
        console.log('Stopping listener', this.subscriptionId);
        if (this.subscriptionId !== null) {
            try {
                await this.connection.removeOnLogsListener(this.subscriptionId);
                console.log('Successfully unsubscribed');
            } catch (err) {
                console.warn('Failed to unsubscribe cleanly:', err);
            }
            this.subscriptionId = null;
        }
    }
}

async function main2() {
    console.log('start')
    await fetchPumpFunPools();
    listenForNewPumpFunPoolCreation();
    listenForValidBlockhash();

    const targetWallet = '...'
    const targetWalletListener = new WalletListener(connection, targetWallet);

    const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("...", "utf-8"))));
    const botWalletListener = new WalletListener(connection, signer.publicKey.toString());

    const solLamportsBuyAmount = '4000000'

    let accounts: PumpFunAccounts;
    let boughtBaseAmount: string;
    let buySignature: string;
    let sellSignature: string;
    let tokenListener: TokenListener;

    targetWalletListener.on("pumpFunSwap", async ({tx: walletTx}: {tx: ParsedPumpFunTx}) => {
        console.log('targetWalletListener walletTx', walletTx)
        if (!accounts && walletTx.swapDirection === 'BUY') {
            console.log('BUYING!')

            accounts = createAccounts(
                signer.publicKey,
                new PublicKey(walletTx.mint),
                walletTx.data.pool,
                walletTx.data.coin_creator,
                walletTx.data.protocol_fee_recipient,
                walletTx.data.protocol_fee_recipient_token_account,
                walletTx.baseTokenProgramId,
            )

            const pumpFunBuyIxs = createPumpFunBuyIxs(
                accounts,
                solLamportsBuyAmount,
                walletTx.data.pool_base_token_reserves.toString(),
                walletTx.data.pool_quote_token_reserves.toString(),
            )

            buySignature = await sendJitoTx(signer, pumpFunBuyIxs)

            console.log('buySignature', buySignature)
        }
    })

    botWalletListener.on("pumpFunSwap", async ({tx: walletTx}) => {
        console.log('botWalletListener walletTx', walletTx)
        if (!boughtBaseAmount && walletTx.swapDirection === 'BUY') {
            boughtBaseAmount = walletTx.data.base_amount_out.toString();

            tokenListener = new TokenListener(connection, walletTx.mint, walletTx.price);

            tokenListener.on("priceUpdate", async ({ initialPrice, currentPrice, diff, tx: tokenTx }) => {
                console.log('initialPrice', initialPrice.toString())
                console.log('currentPrice', currentPrice.toString())
                console.log('diff', diff.toString())

                if (boughtBaseAmount && !sellSignature && (diff.gte(1) || diff.lte(-2))) {
                    console.log("Target reached (+1%/-2%). Selling...");

                    const pumpFunSellIxs = createPumpFunSellIxs(
                        accounts,
                        boughtBaseAmount,
                        tokenTx.data.pool_base_token_reserves.toString(),
                        tokenTx.data.pool_quote_token_reserves.toString(),
                    )

                    sellSignature = await sendJitoTx(signer, pumpFunSellIxs)

                    console.log('sellSignature', sellSignature);

                    await tokenListener.stop();

                    boughtBaseAmount = null;
                    accounts = null;
                    sellSignature = null;
                }
            })

            tokenListener.start();
        }
    })

    botWalletListener.start();
    targetWalletListener.start();
}

function parseTx(signature: string, logs: string[]): ParsedPumpFunTx  {
    console.log('signature', signature)
    const pumpFunProgramEventsStartIndex = logs.findIndex(message => message.includes('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'));

    if (pumpFunProgramEventsStartIndex === -1) {
        // console.warn('COULD NOT FIND PUMP PROGRAM', hash)
        return;
    }

    const pumpFunSwapEventsStartIndex = logs.findIndex((message, i) => i >= pumpFunProgramEventsStartIndex && message.includes('Program log: Instruction: TransferChecked'))

    if (pumpFunSwapEventsStartIndex === -1) {
        // console.warn('COULD NOT FIND PUMP SWAP EVENT', hash)
        return;
    }

    const pumpFunSwapEvents = logs.slice(pumpFunSwapEventsStartIndex, logs.length)
    const swapEvent = pumpFunSwapEvents.find(message => message.startsWith('Program data:')).replace('Program data: ', '');
    const decoded = coder.events.decode(swapEvent);

    console.log('decoded.name', decoded.name)

    let amountOut: Big = undefined;
    let amountIn: Big = undefined;
    let price: Big = undefined;
    let swapDirection: 'BUY' | 'SELL';

    let mint: string;
    let pool: string;

    if (decoded.name === 'BuyEvent') {
        swapDirection = 'BUY';
        amountOut = new Big(decoded.data.base_amount_out.toString())
        amountIn = new Big(decoded.data.user_quote_amount_in.toString())
        price = amountIn.div(amountOut);

        pool = decoded.data.pool.toString();
        mint = PUMP_FUN_TOKENS_MAP.get(pool)
    } else if (decoded.name === 'SellEvent') {
        swapDirection = 'SELL';
        amountOut = new Big(decoded.data.user_quote_amount_out.toString())
        amountIn = new Big(decoded.data.base_amount_in.toString())
        price = amountOut.div(amountIn);

        pool = decoded.data.pool.toString();
        mint = PUMP_FUN_TOKENS_MAP.get(pool)
    }

    if (!mint) {
        console.log('NO TOKEN MINT')
        return;
    }

    const hasToken2022ProgramId = logs.some(log => log.includes(TOKEN_2022_PROGRAM_ID.toString()))

    return {
        signature,
        swapDirection,
        pool,
        mint,
        amountOut,
        amountIn,
        price,
        data: decoded.data,
        baseTokenProgramId: hasToken2022ProgramId ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    }
}

function createAccounts(
    signer: PublicKey,
    mint: PublicKey,
    pool: PublicKey,
    coinCreator: PublicKey,
    protocolFeeRecipient: PublicKey,
    protocolFeeRecipientTokenAccount: PublicKey,
    baseTokenProgramId: PublicKey,
): PumpFunAccounts {
    const userBaseTokenAccount = getAssociatedTokenAddressSync(
        mint,
        signer,
        false,
        baseTokenProgramId,
        new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID)
    );

    const userQuoteTokenAccount = getAssociatedTokenAddressSync(
        new PublicKey(SOL_MINT), // wSOL mint
        signer,
        false,
        TOKEN_PROGRAM_ID,
        new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID)
    );

    const [coinCreatorVaultAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("creator_vault"), coinCreator.toBuffer()],
        new PublicKey(PUMP_PROGRAM_ID)
    );

    const coinCreatorVaultAta = getAssociatedTokenAddressSync(
        new PublicKey(SOL_MINT),
        coinCreatorVaultAuthority,
        true,
        TOKEN_PROGRAM_ID,
        new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID)
    );

    const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), signer.toBuffer()],
        new PublicKey(PUMP_PROGRAM_ID)
    );

    const [poolBaseTokenAccount] = PublicKey.findProgramAddressSync(
        [
            pool.toBuffer(),
            baseTokenProgramId.toBuffer(),
            mint.toBuffer(),
        ],
        new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
    );

    const [poolQuoteTokenAccount] = PublicKey.findProgramAddressSync(
        [
            pool.toBuffer(),
            TOKEN_PROGRAM_ID.toBuffer(),
            new PublicKey(SOL_MINT).toBuffer(),
        ],
        new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
    );

    const ACCOUNTS = {
        pool: pool,
        user: signer,
        globalConfig: new PublicKey(PUMP_GLOBAL_CONFIG),
        baseMint: new PublicKey(mint),
        quoteMint: new PublicKey(SOL_MINT),
        userBaseTokenAccount: userBaseTokenAccount,
        userQuoteTokenAccount: userQuoteTokenAccount,
        poolBaseTokenAccount: poolBaseTokenAccount,
        poolQuoteTokenAccount: poolQuoteTokenAccount,
        protocolFeeRecipient: protocolFeeRecipient,
        protocolFeeRecipientTokenAccount: protocolFeeRecipientTokenAccount,
        baseTokenProgram: baseTokenProgramId,
        quoteTokenProgram: new PublicKey(TOKEN_PROGRAM_ID),
        systemProgram: new PublicKey(SYSTEM_PROGRAM_ID),
        associatedTokenProgram: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
        eventAuthority: new PublicKey(EVENT_AUTHORITY),
        program: new PublicKey(PUMP_PROGRAM_ID),
        coinCreatorVaultAta: coinCreatorVaultAta, // check if are unique per creator
        coinCreatorVaultAuthority: coinCreatorVaultAuthority, // check if are unique per creator
        globalVolumeAccumulator: new PublicKey(GLOBAL_VOLUME_ACCUMULATOR),
        userVolumeAccumulator: userVolumeAccumulator,
        feeConfig: new PublicKey(PUMP_FEE_CONFIG),
        feeProgram: new PublicKey(PUMP_FEE_PROGRAM),
    };

    return ACCOUNTS
}

function createPumpFunBuyIxs(
    accounts: PumpFunAccounts,
    solLamportsBuyAmount: string,
    poolBaseTokenReserves: string,
    poolQuoteTokenReserves: string,
): TransactionInstruction[] {
    const setComputeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 });
    const setComputePriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 8000 });

    const createBaseTokenAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        accounts.user,        // payer
        accounts.userBaseTokenAccount,    // ATA address
        accounts.user,        // owner
        accounts.baseMint,                // token mint
        accounts.baseTokenProgram
    );

    const createQuoteTokenAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        accounts.user,        // payer
        accounts.userQuoteTokenAccount,    // ATA address
        accounts.user,        // owner
        accounts.quoteMint,                // token mint
    );

    const fundQuoteTokenAccountIx = SystemProgram.transfer({
        fromPubkey: accounts.user,
        toPubkey: accounts.userQuoteTokenAccount,
        lamports: BigInt(solLamportsBuyAmount),
    });

    const syncNativeIx = createSyncNativeInstruction(accounts.userQuoteTokenAccount);

    const {minBaseAmountOut} = calculateBaseAmountOut(new Big(poolBaseTokenReserves), new Big(poolQuoteTokenReserves), new Big(solLamportsBuyAmount))

    // console.log('minBaseAmountOut', minBaseAmountOut.toString())

    const data = getBuyIxData(minBaseAmountOut.toString(), solLamportsBuyAmount)

    const buyIx = createBuyInstruction(data, accounts)

    const closeQuoteTokenAccountIx = createCloseAccountInstruction(
        accounts.userQuoteTokenAccount,
        accounts.user,
        accounts.user
    );

    return [
        setComputeLimitIx,
        setComputePriceIx,
        createBaseTokenAtaIx,
        createQuoteTokenAtaIx,
        fundQuoteTokenAccountIx,
        syncNativeIx,
        buyIx
    ]
}

function createPumpFunSellIxs(
    accounts: PumpFunAccounts,
    baseAmountIn: string,
    poolBaseTokenReserves: string,
    poolQuoteTokenReserves: string,
): TransactionInstruction[] {
    const setComputeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 });
    const setComputePriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 8000 });

    const {minQuoteAmountOut} = calculateQuoteAmountOut(new Big(poolBaseTokenReserves), new Big(poolQuoteTokenReserves), new Big(baseAmountIn))

    const sellData = getSellIxData(baseAmountIn, minQuoteAmountOut.toString());
    const sellIx = createSellIx(sellData, accounts);

    const closeQuoteTokenAccountIx = createCloseAccountInstruction(
        accounts.userQuoteTokenAccount,
        accounts.user,
        accounts.user,
    );

    return [setComputeLimitIx, setComputePriceIx, sellIx, closeQuoteTokenAccountIx]
}

async function sendJitoTx(
    signer: Keypair,
    ixs: TransactionInstruction[]
): Promise<TransactionSignature> {
    const jitoTipAddress = '...';

    const jitoTipIx = SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: new PublicKey(jitoTipAddress),
        lamports: 100000,
    })

    const msg = new TransactionMessage({
        payerKey: signer.publicKey,
        recentBlockhash: VALID_BLOCKHASH,
        instructions: [...ixs, jitoTipIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg)
    tx.sign([signer])

    const txBase64 = Buffer.from(tx.serialize()).toString('base64');

    const body = {
        "id": 1,
        "jsonrpc": "2.0",
        "method": "sendTransaction",
        "params": [
            txBase64,
            {
                "encoding": "base64"
            }
        ]
    }

    const response = await fetch(
        'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/transactions',
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }
    )

    const json = await response?.json();

    console.log('response', json)

    return json?.result || '';
}

function createBuyInstruction(data: Buffer, accounts: PumpFunAccounts): TransactionInstruction {
    const keys = [
        {pubkey: accounts.pool, isSigner: false, isWritable: true},
        {pubkey: accounts.user, isSigner: true, isWritable: true},
        {pubkey: accounts.globalConfig, isSigner: false, isWritable: false},
        {pubkey: accounts.baseMint, isSigner: false, isWritable: false},
        {pubkey: accounts.quoteMint, isSigner: false, isWritable: false},
        {pubkey: accounts.userBaseTokenAccount, isSigner: false, isWritable: true},
        {pubkey: accounts.userQuoteTokenAccount, isSigner: false, isWritable: true},
        {pubkey: accounts.poolBaseTokenAccount, isSigner: false, isWritable: true},
        {pubkey: accounts.poolQuoteTokenAccount, isSigner: false, isWritable: true},
        {pubkey: accounts.protocolFeeRecipient, isSigner: false, isWritable: false},
        {pubkey: accounts.protocolFeeRecipientTokenAccount, isSigner: false, isWritable: true},
        {pubkey: accounts.baseTokenProgram, isSigner: false, isWritable: false},
        {pubkey: accounts.quoteTokenProgram, isSigner: false, isWritable: false},
        {pubkey: accounts.systemProgram, isSigner: false, isWritable: false},
        {pubkey: accounts.associatedTokenProgram, isSigner: false, isWritable: false},
        {pubkey: accounts.eventAuthority, isSigner: false, isWritable: false},
        {pubkey: accounts.program, isSigner: false, isWritable: false},
        {pubkey: accounts.coinCreatorVaultAta, isSigner: false, isWritable: true},
        {pubkey: accounts.coinCreatorVaultAuthority, isSigner: false, isWritable: false},
        {pubkey: accounts.globalVolumeAccumulator, isSigner: false, isWritable: true},
        {pubkey: accounts.userVolumeAccumulator, isSigner: false, isWritable: true},
        {pubkey: accounts.feeConfig, isSigner: false, isWritable: false},
        {pubkey: accounts.feeProgram, isSigner: false, isWritable: false},
    ];

    return new TransactionInstruction({
        programId: new PublicKey(PUMP_PROGRAM_ID),
        keys,
        data,
    });
}

function getBuyIxData(tokenAmount: string, maxSolAmount: string): Buffer {
    const discriminator = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]); // fixed

    const dataBuffer = Buffer.alloc(25)
    discriminator.copy(dataBuffer, 0);

    dataBuffer.writeBigUInt64LE(BigInt(tokenAmount), 8);
    dataBuffer.writeBigUInt64LE(BigInt(maxSolAmount), 16);

    dataBuffer.writeUInt8(0x00, 24);

    const data = new Uint8Array(dataBuffer);

    return dataBuffer;
}

function calculateBaseAmountOut(poolBaseAmount: Big, poolQuoteAmount: Big, quoteAmountIn: Big, slippagePct: string = '10') {
    const k = poolBaseAmount.mul(poolQuoteAmount);
    const newPoolBaseAmount = k.div(poolQuoteAmount.plus(quoteAmountIn));
    const baseAmountOut = poolBaseAmount.minus(newPoolBaseAmount).round();

    const slippageFactor = new Big(100).minus(slippagePct).div(100);

    const minBaseAmountOut = baseAmountOut.mul(slippageFactor).round();

    return { baseAmountOut, minBaseAmountOut };
}

function calculateQuoteAmountOut(
    poolBaseAmount: Big,
    poolQuoteAmount: Big,
    baseAmountIn: Big,
    slippagePct: string = '10'
) {
// Constant product (x * y = k)
    const k = poolBaseAmount.mul(poolQuoteAmount);

    // Add base tokens into the pool
    const newPoolQuoteAmount = k.div(poolBaseAmount.plus(baseAmountIn));

    // You receive the difference in quote tokens
    const quoteAmountOut = poolQuoteAmount.minus(newPoolQuoteAmount).round();

    // Apply slippage protection
    const slippageFactor = new Big(100).minus(slippagePct).div(100);
    const minQuoteAmountOut = quoteAmountOut.mul(slippageFactor).round();

    return { quoteAmountOut, minQuoteAmountOut };
}

function getSellIxData(baseAmountIn: string, minQuoteAmountOut: string): Buffer {
    const discriminator = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]); // from IDL
    const dataBuffer = Buffer.alloc(24);

    discriminator.copy(dataBuffer, 0);

    dataBuffer.writeBigUInt64LE(BigInt(baseAmountIn), 8);
    dataBuffer.writeBigUInt64LE(BigInt(minQuoteAmountOut), 16);

    return dataBuffer;
}

function createSellIx(data: Buffer, accounts: PumpFunAccounts): TransactionInstruction {
    const keys = [
        {pubkey: accounts.pool, isSigner: false, isWritable: true},
        {pubkey: accounts.user, isSigner: true, isWritable: true},
        {pubkey: accounts.globalConfig, isSigner: false, isWritable: false},
        {pubkey: accounts.baseMint, isSigner: false, isWritable: false},
        {pubkey: accounts.quoteMint, isSigner: false, isWritable: false},
        {pubkey: accounts.userBaseTokenAccount, isSigner: false, isWritable: true},
        {pubkey: accounts.userQuoteTokenAccount, isSigner: false, isWritable: true},
        {pubkey: accounts.poolBaseTokenAccount, isSigner: false, isWritable: true},
        {pubkey: accounts.poolQuoteTokenAccount, isSigner: false, isWritable: true},
        {pubkey: accounts.protocolFeeRecipient, isSigner: false, isWritable: false},
        {pubkey: accounts.protocolFeeRecipientTokenAccount, isSigner: false, isWritable: true},
        {pubkey: accounts.baseTokenProgram, isSigner: false, isWritable: false},
        {pubkey: accounts.quoteTokenProgram, isSigner: false, isWritable: false},
        {pubkey: accounts.systemProgram, isSigner: false, isWritable: false},
        {pubkey: accounts.associatedTokenProgram, isSigner: false, isWritable: false},
        {pubkey: accounts.eventAuthority, isSigner: false, isWritable: false},
        {pubkey: accounts.program, isSigner: false, isWritable: false},
        {pubkey: accounts.coinCreatorVaultAta, isSigner: false, isWritable: true},
        {pubkey: accounts.coinCreatorVaultAuthority, isSigner: false, isWritable: false},
        {pubkey: accounts.feeConfig, isSigner: false, isWritable: false},
        {pubkey: accounts.feeProgram, isSigner: false, isWritable: false},
    ];

    return new TransactionInstruction({
        programId: new PublicKey(PUMP_PROGRAM_ID),
        keys,
        data,
    });
}

function parseCreatePoolLogs(logs: string[]): {mint: string, pool: string} {
    const createPoolEventsStartIndex = logs.findIndex(log => log.includes('Program log: Instruction: MintTo'))

    if (createPoolEventsStartIndex === -1) {
        return;
    }

    const createPoolEvents = logs.slice(createPoolEventsStartIndex, logs.length)

    const createPoolEvent = createPoolEvents?.find(log => log.startsWith('Program data:'))?.replace('Program data: ', '');

    if (!createPoolEvent) {
        return;
    }

    const decoded = coder.events.decode(createPoolEvent);
    console.log('decoded', decoded)

    const mint = decoded.data.base_mint.toString();

    if (!mint.includes('pump')) {
        return null;
    }

    return {
        mint,
        pool: decoded.data.pool.toString()
    }
}

async function fetchPumpFunPools(): Promise<void> {
    const query = `
    query MyQuery {
      pump_fun_amm_Pool(order_by: { _updatedAt: desc }) {
        base_mint
        lp_supply
        pubkey
        _updatedAt
        _lamports
      }
    }
  `;

    const res = await fetch(`...`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
    });

    const json = await res.json();

    const pools = json?.data?.pump_fun_amm_Pool
    console.log('FETCHED POOLS', pools.length)

    pools.forEach(pool => {
        if (pool.base_mint?.includes('pump')) {
            PUMP_FUN_TOKENS_MAP.set(pool.pubkey, pool.base_mint)
        }
    })
}

function listenForValidBlockhash() {
    connection.onSlotChange(
        async (log) => {
            if (log.slot && ((VALID_BLOCKHASH_SLOT + 100 < log.slot) || !VALID_BLOCKHASH)) {
                VALID_BLOCKHASH = (await connection.getLatestBlockhash())?.blockhash
                VALID_BLOCKHASH_SLOT = log.slot;
                console.log('NEW BLOCKHASH', VALID_BLOCKHASH)
            }
        },
        "confirmed"
    );
}

function listenForNewPumpFunPoolCreation() {
    const programId = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')

    connection.onLogs(
        programId,
        (log) => {
            if (log.err) {
                return;
            }

            if (log.logs.includes('Program log: Instruction: InitializeMint2')) {
                const {pool, mint} = parseCreatePoolLogs(log.logs) || {};

                if (pool && mint) {
                    PUMP_FUN_TOKENS_MAP.set(pool, mint);
                }
            }
        },
        "confirmed"
    );
}

main2();
