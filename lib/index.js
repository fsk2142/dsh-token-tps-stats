// src/index.ts
/**
* 本包的 host 入口。
*
* ## 为什么一个「纯客户端插件」也要有 host 入口
*
* 宿主的 `client-modules` 启动图扫描只认两种行名：**裸包名**（产生客户端 source）
* 与**路径写法**（也产生，但界面会显示成宿主改写后的绝对 `file:` URL）。
*
* 界面要体面就只能用裸包名，而裸包名会解析到本文件 —— 于是它**必须导出 `apply`**，
* 否则这一行不算有效插件（`reconcilePackage` 会把它当坏行）。
*
* 本插件没有任何 host 侧逻辑：tok/s 完全由客户端订阅 `assistant/live-chunk` 算出来。
* 所以 `apply` 是一个明确的空实现 —— 不是占位符，而是这个插件真的不需要做事。
*
* @module dsh-token-tps-stats/src/index
*/
/** 包名（客户端与诊断工具按它找人）。 */
const PACKAGE_NAME = "dsh-token-tps-stats";
/**
* 插件 id（`cordis.patch.yml` 里那一行的 `id` 与它一致）。
*
* `name` 是 cordis 用来标识插件实现的字段；与包名相同即可。
*/
const name = PACKAGE_NAME;
/**
* 本插件**不需要**任何 host 侧服务。
*
* 留空数组而不是省略：cordis 对 `inject` 的缺省语义是「不注入任何服务」，
* 显式声明让「这个插件确实不碰 host」这件事在代码里可见。
*/
const inject = [];
/**
* 插件入口（空实现）。
*
* 为什么不抛错提示「应该用客户端」：宿主对每一行都会调 `apply`，
* 抛错会让这一行显示为激活失败 —— 而它其实一切正常，只是没有 host 侧工作。
*/
function apply() {}
export { PACKAGE_NAME, apply, inject, name };
