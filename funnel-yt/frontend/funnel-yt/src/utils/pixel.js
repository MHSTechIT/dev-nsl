// Meta Pixel removed for the YT pipeline — YT traffic is not optimised by
// Facebook Ads, so firing fbq events here would be noise. Every export is a
// no-op so existing call sites keep compiling without changes.
const noop = () => {};

export const pixelPageView = noop;
export const pixelViewContent = noop;
export const pixelInitiateQualification = noop;
export const pixelSugarLevelSelected = noop;
export const pixelDisqualifiedLead = noop;
export const pixelLanguageQualified = noop;
export const pixelDurationSelected = noop;
export const pixelInitiateRegistration = noop;
export const pixelLead = noop;
export const pixelCompleteRegistration = noop;
export const pixelPurchase = noop;
export const pixelGroupJoinInitiated = noop;
export const pixelFormAbandoned = noop;
export const pixelBackNavigation = noop;
