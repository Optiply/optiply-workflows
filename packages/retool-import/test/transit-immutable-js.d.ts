declare module 'transit-immutable-js' {
  interface Serializer {
    toJSON(value: unknown): string
    fromJSON(json: string): unknown
    withRecords(records: unknown[]): Serializer
  }
  const serializer: Serializer
  export default serializer
}
