import neostandard from 'neostandard'
const ns = neostandard({ ts: true })
for (const item of ns) {
  if (item?.languageOptions?.ecmaVersion < 2025) {
    item.languageOptions.ecmaVersion = 2025
  }
}
export default ns
