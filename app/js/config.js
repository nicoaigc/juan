/* 云服务接入参数 —— 由 WorkBuddy 云服务开通时返回的 publicConfig。
   这三个值是**唯一**可以放进前端代码的接入信息：endpoint 是本应用的发布域数据面地址，
   publishableKey 只标识"是哪个应用"、本身不带权限（服务端按 Origin 精确校验），
   oauthRelayBaseUrl 供微信扫码登录使用。

   ⚠️ 不要改成别的地址，也不要从 location / 环境变量里推——服务端按精确 Origin 校验，
     换了域登录就废了。要换应用请重新开通云服务并整体替换本文件。 */
window.PUBLIC_CONFIG = {
  endpoint: "https://shijuan-question-bank.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_xotiBVMY1FXqdzhi2ZChQ7_1EWxudzMkM8AC6JadbMNZLhpBoIbypGa",
};
