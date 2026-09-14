/* Operator side of payday: claim Pons creator fees, buy the reward Stock Tokens with ETH, pay players.
   NVDA is bought in its native-ETH Uniswap v4 pool (0.05%), GLD through Uniswap v3 WETH/USDG (0.01%) and USDG/GLD (0.3%), both through
   the Universal Router. Quotes come from eth_simulateV1 against the real chain. The key lives only in the Vercel env
   var RWAEX_OPERATOR_KEY. */
import { createWalletClient, http, encodeAbiParameters, encodeFunctionData, encodePacked, erc20Abi, parseAbi, decodeFunctionResult, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { pub, CHAIN, STOCKS } from './game.js';

export const ROUTER = '0x8876789976dEcBfCbBbe364623C63652db8C0904';
export const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e';
const ESCROW_ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function claim()']);
const ROUTER_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const MSG_SENDER = '0x0000000000000000000000000000000000000001';
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
const POOL_KEY = { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] };

export function operator() {
  const key = process.env.RWAEX_OPERATOR_KEY || '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw Error('The payday operator is not configured yet.');
  const account = privateKeyToAccount(key);
  return { account, address: account.address, wallet: createWalletClient({ account, chain: CHAIN, transport: http(CHAIN.rpcUrls.default.http[0], { timeout: 30000 }) }) };
}
export const operatorAddress = () => { try { return operator().address; } catch { return null; } };

export async function sendTx(o, tx) {
  const hash = await o.wallet.sendTransaction({ account: o.account, chain: CHAIN, ...tx });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90000 });
  if (rc.status !== 'success') throw Error('Transaction reverted ' + hash);
  return hash;
}

/* Universal Router calldata for ETH -> stock */
export function buyCalldata(stock, amountIn, minOut, deadline) {
  if (stock === 'press') {
    const key = { currency0: '0x0000000000000000000000000000000000000000', currency1: STOCKS.press.address, fee: 500, tickSpacing: 10, hooks: '0x0000000000000000000000000000000000000000' };
    const swap = encodeAbiParameters([{ type: 'tuple', components: [{ ...POOL_KEY, name: 'poolKey' }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }],
      [{ poolKey: key, zeroForOne: true, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: '0x' }]);
    const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key.currency0, amountIn]);
    const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key.currency1, minOut]);
    const actions = encodePacked(['uint8', 'uint8', 'uint8'], [0x06, 0x0c, 0x0f]);
    const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [swap, settle, take]]);
    return encodeFunctionData({ abi: ROUTER_ABI, functionName: 'execute', args: ['0x10', [input], BigInt(deadline)] });
  }
  const wrap = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ADDRESS_THIS, amountIn]);
  /* the single-hop WETH/GLD pool rejects router swaps; WETH -> USDG (0.01%) -> GLD (0.3%) fills */
  const path = encodePacked(['address', 'uint24', 'address', 'uint24', 'address'], [WETH, 100, USDG, 3000, STOCKS.refinery.address]);
  const swap = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }], [MSG_SENDER, amountIn, minOut, path, false]);
  return encodeFunctionData({ abi: ROUTER_ABI, functionName: 'execute', args: ['0x0b00', [wrap, swap], BigInt(deadline)] });
}

/* simulated stock received for `amountIn` ETH, from `from` (balance overridden so any address can quote) */
export async function quoteBuy(stock, amountIn, from) {
  const data = buyCalldata(stock, amountIn, 0n, Math.floor(Date.now() / 1000) + 600);
  const token = STOCKS[stock].address;
  const bal = encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [from] });
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ stateOverrides: { [from]: { balance: toHex(amountIn * 2n + 10n ** 17n) } }, calls: [{ from, to: token, data: bal }, { from, to: ROUTER, data, value: toHex(amountIn) }, { from, to: token, data: bal }] }], validation: false }, 'latest'] };
  const r = await (await fetch(CHAIN.rpcUrls.default.http[0], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  if (r.error) throw Error('Quote failed: ' + r.error.message);
  const calls = r.result[0].calls;
  if (calls[1].status !== '0x1') throw Error('Swap simulation reverted');
  const read = c => decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: c.returnData });
  return read(calls[2]) - read(calls[0]);
}

export async function buy(o, stock, amountIn) {
  const out = await quoteBuy(stock, amountIn, o.address);
  const minOut = out * 97n / 100n;
  const token = STOCKS[stock].address;
  const before = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [o.address] });
  const hash = await sendTx(o, { to: ROUTER, data: buyCalldata(stock, amountIn, minOut, Math.floor(Date.now() / 1000) + 600), value: amountIn });
  const after = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [o.address] });
  return { hash, bought: after - before, quoted: out };
}

export async function claimCreatorFees(o) {
  const bal = await pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: 'balanceOf', args: [o.address] }).catch(() => 0n);
  if (bal <= 0n) return null;
  const hash = await sendTx(o, { to: ESCROW, data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'claim' }) });
  return { hash, amount: bal };
}

export async function transferStock(o, stock, to, amount) {
  return sendTx(o, { to: STOCKS[stock].address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }) });
}
