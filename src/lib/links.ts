/**
 * 唯一真相源：对外链接与发布清单地址。
 *
 * 不要在组件里散落硬编码 URL —— 换域名、加镜像、改仓库地址时只改这里。
 */

/** 产品官网 / 下载页（更新弹窗的主入口）。 */
export const PRODUCT_HOME_URL = "https://eds.tsagent.cc/";

/** 发布清单（由 sync-r2.yml 生成，含最新版本号与各平台安装包直链）。 */
export const RELEASE_MANIFEST_URL = "https://dl.tsagent.cc/easy-dataset/latest.json";

/** 源码仓库。 */
export const REPO_URL = "https://github.com/MWang-TS/easy-dataset";

/** Releases 列表页（官网之外的备用下载入口）。 */
export const RELEASES_URL = `${REPO_URL}/releases`;

/**
 * 旧版兜底：直接抓官网 HTML 里的 `releases/tag/vX.Y.Z`。
 * 新站点是 Astro + JS 渲染，HTML 里已没有版本号，仅在清单不可用时兜底。
 */
export const DOWNLOAD_PAGE_URL = "https://eds.tsagent.cc/index.html";

/** 出品方。 */
export const STUDIO_URL = "https://tsagent.cc/";

/** 联系邮箱（关于面板里的「联系作者」）。 */
export const CONTACT_EMAIL = "gawain@tsagent.cc";
