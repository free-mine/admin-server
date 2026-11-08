import { ZeroAddress } from 'ethers'
import type { Chain } from '../chain/index.js'
import { ensure } from '../shared/index.js'

export async function readFund(chain: Chain) {
  const block = await chain.provider.getBlockNumber()
  const options = { blockTag: block }
  const [currentShiftId, entryPrice, priceUpdatedAt, dollar, magicOre, contractURI] = await Promise.all([
    chain.freeMine.currentShiftId(options), chain.freeMine.entryPrice(options), chain.freeMine.priceUpdatedAt(options),
    chain.freeMine.dollar(options), chain.freeMine.magicOre(options), chain.oreVein.contractURI(options),
  ])
  return { block, currentShiftId: String(currentShiftId), entryPrice: String(entryPrice), priceDecimals: 18,
    priceUpdatedAt: Number(priceUpdatedAt), nextPriceUpdateAt: Number(priceUpdatedAt) + 604800,
    minimumEntryPrice: (BigInt(entryPrice) * 96n / 100n).toString(),
    maximumEntryPrice: (BigInt(entryPrice) * 104n / 100n).toString(),
    minimumExitPrice: (BigInt(entryPrice) * 90n / 100n).toString(),
    maximumExitPrice: (BigInt(entryPrice) * 99n / 100n).toString(),
    dollar: String(dollar), magicOre: String(magicOre), contractURI: String(contractURI) }
}
export async function readShift(chain: Chain, id: string) {
  const block = await chain.provider.getBlockNumber()
  const current = BigInt(await chain.freeMine.currentShiftId({ blockTag: block }))
  ensure(BigInt(id) > 0n && BigInt(id) <= current, 'SHIFT_NOT_FOUND')
  const shift = await chain.freeMine.shifts(id, { blockTag: block })
  return { block, id, closed: BigInt(id) < current, funded: Boolean(shift.funded), price: String(shift.price),
    dollar: String(shift.dollar), fundedAt: Number(shift.fundedAt), oreAmount: String(shift.oreAmount),
    dollarScale: String(shift.dollarScale), currentClaimId: String(shift.currentClaimId),
    expireAvailableAt: shift.funded ? Number(shift.fundedAt) + 1209600 : null }
}
export async function readClaims(chain: Chain, shiftId: string, offset: number, limit: number) {
  const shift = await readShift(chain, shiftId)
  const total = BigInt(shift.currentClaimId)
  const claims = []
  // currentClaimId — последний выданный ID. Закрытые заявки оставляют пропуски.
  for (let id = BigInt(offset) + 1n; id <= total && id <= BigInt(offset + limit); id++) {
    try {
      const claim = await chain.freeMine.getClaim(shiftId, id, { blockTag: shift.block })
      if (String(claim.miner) !== ZeroAddress) claims.push({ id: id.toString(), miner: String(claim.miner), oreAmount: String(claim.oreAmount) })
    } catch (error) {
      // Только ClaimNotFound означает закрытую заявку; сетевые ошибки не маскируются.
      const data = error && typeof error === 'object' && 'data' in error ? error.data : undefined
      let missing = false
      if (typeof data === 'string') {
        try { missing = chain.freeMine.interface.parseError(data)?.name === 'ClaimNotFound' } catch { /* Неизвестная ошибка. */ }
      }
      if (!missing) throw error
    }
  }
  return { block: shift.block, shiftId, totalIds: total.toString(), offset, limit, claims }
}
