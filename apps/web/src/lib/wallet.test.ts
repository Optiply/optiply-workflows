import { describe, expect, it } from 'vitest'
import { walletZip } from '../../e2e/wallet-zip'
import { tnsAliases, walletAliases } from './wallet'

const TNS = `mydb_high = (description= (retry_count=20)(address=(protocol=tcps)(port=1522)(host=adb.eu-frankfurt-1.oraclecloud.com))(connect_data=(service_name=abc_mydb_high.adb.oraclecloud.com)))

mydb_low = (description=(address=(protocol=tcps)(port=1522)(host=adb.eu-frankfurt-1.oraclecloud.com))(connect_data=(service_name=abc_mydb_low.adb.oraclecloud.com)))
`

describe('Oracle wallets', () => {
  it('names the aliases in tnsnames.ora, deflated or stored', async () => {
    for (const deflate of [true, false]) {
      const zip = walletZip({ 'Wallet_mydb/cwallet.sso': 'binary', 'Wallet_mydb/tnsnames.ora': TNS }, deflate)
      expect(await walletAliases(zip)).toEqual(['mydb_high', 'mydb_low'])
    }
  })

  it('gives none for anything else', async () => {
    expect(await walletAliases(new Uint8Array([1, 2, 3]))).toEqual([])
    expect(await walletAliases(walletZip({ 'cwallet.sso': 'x' }))).toEqual([])
    expect(tnsAliases('# a comment\n  indented = (x)\nok.alias=(y)')).toEqual(['ok.alias'])
  })
})
