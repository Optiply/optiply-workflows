// Bundled by esbuild into a single IIFE and baked into the isolate snapshot.
// Everything assigned to globalThis here is available to user code and {{ }} expressions.
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat'
import relativeTime from 'dayjs/plugin/relativeTime'
import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'
import _ from 'lodash'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.extend(customParseFormat)
dayjs.extend(relativeTime)

globalThis._ = _
globalThis.dayjs = dayjs
