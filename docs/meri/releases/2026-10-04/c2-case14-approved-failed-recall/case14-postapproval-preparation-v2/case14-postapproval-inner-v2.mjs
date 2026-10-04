// Codex local preparation. NOT RUN. Root owns ECS lifecycle and independent review.
// This adapter does not approve memory or account for approval projection providers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Fixed local read-only module. Both raw bytes and code are pinned into this adapter.
const PROJECTION_SOURCE_SHA256 = '635ae39807fc884569577f199dad4db4c27d4335c8c61b6fff298b317de77e1d';
const PROJECTION_MODULE_B64 = 'Ly8gQ29kZXggTE9DQUwgRFJBRlQuIE5vIGFwcHJvdmFsLCBwcm92aWRlciwgcHJvamVjdGlvbiwgcmVwYWlyLCBidWRnZXQgb3Igam91cm5hbCB3cml0ZS4KLy8gVGhlIHNvdXJjZS1vd25lZCBjYW5vbmljYWwgdmVyaWZpZXIgdGFrZXMgcm93IGxvY2tzOyBkbyBub3QgbWFyayBpdHMgdHJhbnNhY3Rpb24gUkVBRCBPTkxZLgppbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7CmltcG9ydCB7Y3JlYXRlSGFzaH0gZnJvbSAnbm9kZTpjcnlwdG8nOwppbXBvcnQge2NyZWF0ZVJlcXVpcmV9IGZyb20gJ25vZGU6bW9kdWxlJzsKaW1wb3J0IHtzcGF3blN5bmN9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7CmltcG9ydCB7cmVzb2x2ZX0gZnJvbSAnbm9kZTpwYXRoJzsKaW1wb3J0IHtwYXRoVG9GaWxlVVJMfSBmcm9tICdub2RlOnVybCc7CmNvbnN0IFNPVVJDRT0nYzBmMzkzZjg2M2JmNzNiZDRlNjVlN2E5NGUxN2MwNzNlN2JlMDIxZSc7CmNvbnN0IEZJWFRVUkU9J2RlZTRlOTBlLThlOTEtNDc4Mi05NDg4LTEwYjhlNTJhMjE0NicsQ0FORElEQVRFPSc2ZjQ1NDVhMS1kY2Q1LTVlYmEtODYwNi1kYjIwNDNiMjM4YWMnOwpjb25zdCBURU5BTlQ9J2YyZDZjZjhmLTA1N2MtNDc5YS04MTEwLTYyZmU1MDg2ZDQzZicsQ0xJRU5UPSc0MWY5ZWM2My0zOTYzLTQ3OWYtYjc0Ny01OWEzNzY3ZWY0NGInOwpjb25zdCBQUklZQT0nZmIyMThiZjUtMjY3NC00Y2VkLWJjYTMtN2E1ZDBjMDE1OTJmJyxQQVQ9J2IxZjc1OGZjLTE3YmQtNDBmOC1iZWYyLWZhMmQyMzgwMzAwZic7CmNvbnN0IEhBU0g9L15bYS1mMC05XXs2NH0kL3UsVVVJRD0vXlthLWYwLTldezh9LVthLWYwLTldezR9LTRbYS1mMC05XXszfS1bODlhYl1bYS1mMC05XXszfS1bYS1mMC05XXsxMn0kL3U7CmNvbnN0IHNoYT12PT5jcmVhdGVIYXNoKCdzaGEyNTYnKS51cGRhdGUodikuZGlnZXN0KCdoZXgnKTsKY29uc3Qgc3RhYmxlPXg9PkFycmF5LmlzQXJyYXkoeCk/eC5tYXAoc3RhYmxlKTp4JiZ0eXBlb2YgeD09PSdvYmplY3QnP09iamVjdC5mcm9tRW50cmllcyhPYmplY3Qua2V5cyh4KS5zb3J0KCkubWFwKGs9PltrLHN0YWJsZSh4W2tdKV0pKTp4OwpleHBvcnQgY29uc3Qgc3RhYmxlSGFzaD14PT5zaGEoSlNPTi5zdHJpbmdpZnkoc3RhYmxlKHgpKSk7CmNvbnN0IGtleXM9KHYsd2FudGVkKT0+YXNzZXJ0LmRlZXBFcXVhbChPYmplY3Qua2V5cyh2KS5zb3J0KCksWy4uLndhbnRlZF0uc29ydCgpKTsKY29uc3QgaXNvPXY9Pntjb25zdCBzPXYgaW5zdGFuY2VvZiBEYXRlP3YudG9JU09TdHJpbmcoKTp2O2Fzc2VydC5lcXVhbCh0eXBlb2Ygcywnc3RyaW5nJyk7YXNzZXJ0Lm9rKE51bWJlci5pc0Zpbml0ZShEYXRlLnBhcnNlKHMpKSk7cmV0dXJuIG5ldyBEYXRlKHMpLnRvSVNPU3RyaW5nKCk7fTsKZXhwb3J0IGZ1bmN0aW9uIGV4cGVjdGVkUHJvamVjdGlvbigpewogY29uc3QgdGl0bGU9YG1lcmktZm91bmRhdGlvbi0yMDI2MDkyODoke0ZJWFRVUkV9Ok1FTS1QUk9QT1NBTC0xNGAsdmFsdWU9J1N5bnRoZXRpYyBBc3RlciBjYW5kaWRhdGUgZm9yIGFwcHJvdmFsJzsKIGNvbnN0IHNlY3Rpb25zPVt7a2V5OidtZW1vcnknLGhlYWRpbmc6J01lbW9yeScsb3duZXI6J2h1bWFuJyxib2R5OnZhbHVlfV0sdGV4dD10aXRsZSsnIE1lbW9yeTogJyt2YWx1ZTsKIHJldHVybnt0aXRsZSx2YWx1ZSxzZWN0aW9ucyx0ZXh0LHByb2plY3Rpb25UZXh0U2hhMjU2OnNoYSh0ZXh0KX07Cn0KZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlVGVybWluYWxJbnB1dChpbnB1dCxub3c9RGF0ZS5ub3coKSl7CiBrZXlzKGlucHV0LFsna2luZCcsJ3ZlcnNpb24nLCdzb3VyY2VTaGEnLCdjYXB0dXJlUnVuSWQnLCdhcHByb3ZhbEV2aWRlbmNlU2hhMjU2JywnYXBwcm92ZWRPd25lcicsJ3dpbmRvd1N0YXJ0ZWRBdCcsJ2RlYWRsaW5lQXQnXSk7CiBhc3NlcnQuZXF1YWwoaW5wdXQua2luZCwnY2FzZTE0LXByb2plY3Rpb24tdGVybWluYWwtcmVhZC1pbnB1dCcpO2Fzc2VydC5lcXVhbChpbnB1dC52ZXJzaW9uLDEpO2Fzc2VydC5lcXVhbChpbnB1dC5zb3VyY2VTaGEsU09VUkNFKTsKIGFzc2VydC5tYXRjaChpbnB1dC5jYXB0dXJlUnVuSWQsVVVJRCk7YXNzZXJ0Lm1hdGNoKGlucHV0LmFwcHJvdmFsRXZpZGVuY2VTaGEyNTYsSEFTSCk7CiBjb25zdCBzdGFydD1EYXRlLnBhcnNlKGlucHV0LndpbmRvd1N0YXJ0ZWRBdCksZGVhZGxpbmU9RGF0ZS5wYXJzZShpbnB1dC5kZWFkbGluZUF0KTsKIGFzc2VydC5vayhOdW1iZXIuaXNGaW5pdGUoc3RhcnQpJiZOdW1iZXIuaXNGaW5pdGUoZGVhZGxpbmUpJiZzdGFydDw9bm93JiZub3c8ZGVhZGxpbmUmJmRlYWRsaW5lLXN0YXJ0PD05MDAwMDApOwogY29uc3Qgbz1pbnB1dC5hcHByb3ZlZE93bmVyO2NvbnN0e2N1cnJlbnRWZXJpZnlTaGEyNTYsLi4uYm9keX09bzsKIGtleXMobyxbJ2tpbmQnLCdzY2hlbWFWZXJzaW9uJywnY2FzZUlkJywnZml4dHVyZU5hbWVzcGFjZScsJ2ZpeHR1cmVWZXJzaW9uJywnZml4dHVyZUluc3RhbmNlSWQnLCdtYW5pZmVzdENvbnRlbnRTaGEyNTYnLCdyZWNpcGVTaGEyNTYnLCdzZWVkUGxhblNoYTI1NicsJ3NldHVwUmVjZWlwdFNoYTI1NicsJ3RlbmFudElkJywnY2xpZW50SWQnLCdwcm9wb3NlclVzZXJJZCcsJ3Jldmlld2VyVXNlcklkJywncmV2aWV3ZXJSb2xlJywnbG9naWNhbFNvdXJjZUlkJywnY2FuZGlkYXRlSWQnLCdjYW5kaWRhdGVSb3dWZXJzaW9uJywncmV2aXNpb24nLCdvd25lcnNoaXBNYXJrZXJTaGEyNTYnLCdwYXlsb2FkU2hhMjU2JywndGV4dCcsJ3N0YXRlJywnaXRlbScsJ2RlY2lzaW9uJywnY3VycmVudFZlcmlmeVNoYTI1NiddKTsKIGFzc2VydC5lcXVhbChjdXJyZW50VmVyaWZ5U2hhMjU2LHN0YWJsZUhhc2goYm9keSkpO2Fzc2VydC5lcXVhbChvLmtpbmQsJ21lcmktY2FzZTE0LWN1cnJlbnQtbWVtb3J5LW93bmVyJyk7CiBhc3NlcnQuZXF1YWwoby5zY2hlbWFWZXJzaW9uLDEpO2Fzc2VydC5lcXVhbChvLmNhc2VJZCwnMTQnKTthc3NlcnQuZXF1YWwoby5zdGF0ZSwnYXBwcm92ZWQnKTsKIGFzc2VydC5lcXVhbChvLmZpeHR1cmVOYW1lc3BhY2UsJ21lcmktZm91bmRhdGlvbi0yMDI2MDkyOCcpO2Fzc2VydC5lcXVhbChvLmZpeHR1cmVJbnN0YW5jZUlkLEZJWFRVUkUpOwogYXNzZXJ0LmVxdWFsKG8uZml4dHVyZVZlcnNpb24sJ21lcmktbGl2ZS12MS0yMDI2LTA5LTI2LjEnKTthc3NlcnQuZXF1YWwoby5jYW5kaWRhdGVJZCxDQU5ESURBVEUpOwogYXNzZXJ0LmVxdWFsKG8udGVuYW50SWQsVEVOQU5UKTthc3NlcnQuZXF1YWwoby5jbGllbnRJZCxDTElFTlQpO2Fzc2VydC5lcXVhbChvLnByb3Bvc2VyVXNlcklkLFBBVCk7CiBhc3NlcnQuZXF1YWwoby5yZXZpZXdlclVzZXJJZCxQUklZQSk7YXNzZXJ0LmVxdWFsKG8ucmV2aWV3ZXJSb2xlLCd1c2VyX2FkbWluJyk7YXNzZXJ0LmVxdWFsKG8ubG9naWNhbFNvdXJjZUlkLCdNRU0tUFJPUE9TQUwtMTQnKTsKIGFzc2VydC5lcXVhbChvLnJldmlzaW9uLDEpO2Fzc2VydC5lcXVhbChvLnRleHQsZXhwZWN0ZWRQcm9qZWN0aW9uKCkudmFsdWUpOwogYXNzZXJ0LmVxdWFsKG8uc2V0dXBSZWNlaXB0U2hhMjU2LCdjMmM4MGJkZWY1MWU2YjhiMjJkMTNjODA5ZTc3ZTc2YzYxZWI2ODBmYTEwYWNhODgzNzJmMjU4ZDUzYTE1NWY4Jyk7CiBhc3NlcnQuZXF1YWwoby5yZWNpcGVTaGEyNTYsJzE2Njg2NDljODQ1NTBmNzAxZmFlYThlMzA2MTdkYTExYzk0NGM4NGNhZWI5OTk2NWFmYTMxMWFjZDAxN2U1OTMnKTsKIGFzc2VydC5lcXVhbChvLm1hbmlmZXN0Q29udGVudFNoYTI1NiwnNWRlZGE3MGY5NDY5OGE4ZjhlZDgyZDQwZmE4MDRkMTZhZTJlMzlhMDkxMDEyYWYwZDcwMjAzYTBlMWI1ZmMxNCcpOwogYXNzZXJ0LmVxdWFsKG8uc2VlZFBsYW5TaGEyNTYsJzQyZWQ0ZDVhNjQ2NmM5ODM0YTlkNTc4MDkyYjk4ZjA3MDM5ODA4Y2Y0MjRhNmE3NzA5NWFjYTIyMjAyYzIxZjInKTsKIGFzc2VydC5lcXVhbChvLm93bmVyc2hpcE1hcmtlclNoYTI1NiwnNDhiOTU0MTNkN2I4NzZhNDEyZTNjNTM1MmFjNGUzZmVjZmVhNWViOGIyNjBlMmNkMzI3NzM2ODI5ZWUxZmFhYicpOwogYXNzZXJ0LmVxdWFsKG8ucGF5bG9hZFNoYTI1NiwnMWIyMzMzZjk3NjIzNzg5NjgyZWZhNTFmNDc5YThhMGE0NTJhMmM0ZDExODFiMTIxNDM3YzUxZjRmMGJlNDk5ZScpOwogYXNzZXJ0Lm1hdGNoKG8uY2FuZGlkYXRlUm93VmVyc2lvbiwvXlswLTldezEsMTB9JC91KTthc3NlcnQubWF0Y2goby5pdGVtLnJvd1ZlcnNpb24sL15bMC05XXsxLDEwfSQvdSk7CiBrZXlzKG8uaXRlbSxbJ2lkJywnY2xpb01lbW9yeUlkJywncm93VmVyc2lvbicsJ3NvdXJjZVZlcnNpb24nLCdjb250ZW50U2hhMjU2Jywnc3RhdHVzJywnZ292ZXJuZWRTdGF0dXMnXSk7CiBrZXlzKG8uZGVjaXNpb24sWyd0cmFuc2l0aW9uQXVkaXRJZCcsJ2FjdG9yVXNlcklkJywnZGVjaXNpb24nXSk7CiBhc3NlcnQubWF0Y2goby5pdGVtLmlkLFVVSUQpO2Fzc2VydC5tYXRjaChvLml0ZW0uY2xpb01lbW9yeUlkLFVVSUQpO2Fzc2VydC5tYXRjaChvLml0ZW0uY29udGVudFNoYTI1NixIQVNIKTsKIGFzc2VydC5lcXVhbChvLml0ZW0uc291cmNlVmVyc2lvbiwnY2FuZGlkYXRlOicrQ0FORElEQVRFKTthc3NlcnQuZXF1YWwoby5pdGVtLnN0YXR1cywnYWN0aXZlJyk7YXNzZXJ0LmVxdWFsKG8uaXRlbS5nb3Zlcm5lZFN0YXR1cywnYWN0aXZlJyk7CiBhc3NlcnQuZXF1YWwoby5kZWNpc2lvbi5hY3RvclVzZXJJZCxQUklZQSk7YXNzZXJ0LmVxdWFsKG8uZGVjaXNpb24uZGVjaXNpb24sJ2FwcHJvdmVkJyk7YXNzZXJ0Lm1hdGNoKG8uZGVjaXNpb24udHJhbnNpdGlvbkF1ZGl0SWQsVVVJRCk7CiByZXR1cm4gaW5wdXQ7Cn0KCi8vIFJhdyBzbmFwc2hvdCBjb250YWlucyBleGFjdCBib3VuZGVkIHNvdXJjZSByb3dzLCBuZXZlciB2ZWN0b3JzIG9yIHRlbmFudCBzZXR0aW5ncy4KLy8gSWRlbnRpdHkvY29udGVudCBkcmlmdCByZWplY3RzIGltbWVkaWF0ZWx5LiBJbmNvbXBsZXRlIGFzeW5jaHJvbm91cyBicmFuY2hlcyByZXR1cm4gV0FJVC4KZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlUHJvamVjdGlvblNuYXBzaG90KGlucHV0LHJhdyxub3c9RGF0ZS5ub3coKSl7CiB2YWxpZGF0ZVRlcm1pbmFsSW5wdXQoaW5wdXQsbm93KTthc3NlcnQuZGVlcEVxdWFsKHJhdy5jYW5vbmljYWxPd25lcixpbnB1dC5hcHByb3ZlZE93bmVyKTsKIGNvbnN0IG89aW5wdXQuYXBwcm92ZWRPd25lcixlPWV4cGVjdGVkUHJvamVjdGlvbigpOwogYXNzZXJ0LmVxdWFsKHJhdy5jbGlvLmxlbmd0aCwxKTthc3NlcnQuZXF1YWwocmF3Lml0ZW1zLmxlbmd0aCwxKTthc3NlcnQub2socmF3LmVtYmVkZGluZ3MubGVuZ3RoPD0xKTthc3NlcnQub2socmF3LmpvYnMubGVuZ3RoPD0xKTsKIGNvbnN0IGM9cmF3LmNsaW9bMF0saXRlbT1yYXcuaXRlbXNbMF07CiBhc3NlcnQuZXF1YWwoYy5pZCxvLml0ZW0uY2xpb01lbW9yeUlkKTthc3NlcnQuZXF1YWwoYy50ZW5hbnRJZCxURU5BTlQpO2Fzc2VydC5lcXVhbChjLmNsaWVudElkLENMSUVOVCk7YXNzZXJ0LmVxdWFsKGMub3duZXJVc2VySWQsbnVsbCk7CiBhc3NlcnQuZXF1YWwoYy5zY29wZSwnY2xpZW50Jyk7YXNzZXJ0LmVxdWFsKGMua2V5LGUudGl0bGUpO2Fzc2VydC5lcXVhbChjLnZhbHVlLGUudmFsdWUpO2Fzc2VydC5lcXVhbChjLnNvdXJjZSwnbWVyaV9zeW50aGV0aWNfZml4dHVyZScpOwogYXNzZXJ0Lm9rKERhdGUucGFyc2UoaXNvKGMuY3JlYXRlZEF0KSk+PURhdGUucGFyc2UoaW5wdXQud2luZG93U3RhcnRlZEF0KSk7YXNzZXJ0Lm9rKERhdGUucGFyc2UoaXNvKGMudXBkYXRlZEF0KSk+PURhdGUucGFyc2UoaXNvKGMuY3JlYXRlZEF0KSkpO2Fzc2VydC5vayhEYXRlLnBhcnNlKGlzbyhjLnVwZGF0ZWRBdCkpPD1ub3cpOwogYXNzZXJ0LmVxdWFsKGl0ZW0uaWQsby5pdGVtLmlkKTthc3NlcnQuZXF1YWwoaXRlbS50ZW5hbnRJZCxURU5BTlQpO2Fzc2VydC5lcXVhbChpdGVtLmNsaWVudElkLENMSUVOVCk7YXNzZXJ0LmVxdWFsKGl0ZW0ub3duZXJVc2VySWQsbnVsbCk7CiBhc3NlcnQuZXF1YWwoaXRlbS5zdGF0dXMsJ2FjdGl2ZScpO2Fzc2VydC5lcXVhbChpdGVtLmdvdmVybmVkU3RhdHVzLCdhY3RpdmUnKTthc3NlcnQuZXF1YWwoaXRlbS5zb3VyY2VWZXJzaW9uLG8uaXRlbS5zb3VyY2VWZXJzaW9uKTsKIGFzc2VydC5lcXVhbChpdGVtLnNvdXJjZUNvbnRlbnRIYXNoLG8uaXRlbS5jb250ZW50U2hhMjU2KTthc3NlcnQuZXF1YWwoaXRlbS5yb3dWZXJzaW9uLG8uaXRlbS5yb3dWZXJzaW9uKTsKIGFzc2VydC5lcXVhbChpdGVtLnNsdWcsJ2NsaW86JytjLmlkKTthc3NlcnQuZXF1YWwoaXRlbS50aXRsZSxlLnRpdGxlKTthc3NlcnQuZGVlcEVxdWFsKGl0ZW0uc2VjdGlvbnMsZS5zZWN0aW9ucyk7CiBjb25zdCByZWFzb25zPVtdOwogaWYoYy5oYXNMZWdhY3lFbWJlZGRpbmchPT10cnVlKSB7IGFzc2VydC5lcXVhbChjLmhhc0xlZ2FjeUVtYmVkZGluZyxmYWxzZSk7YXNzZXJ0LmVxdWFsKGMubGVnYWN5RGltZW5zaW9ucyxudWxsKTtyZWFzb25zLnB1c2goJ0xFR0FDWV9PUEVOQUlfVkVDVE9SX1BFTkRJTkcnKTsgfQogZWxzZSBhc3NlcnQuZXF1YWwoYy5sZWdhY3lEaW1lbnNpb25zLDE1MzYpOwogaWYoIXJhdy5lbWJlZGRpbmdzLmxlbmd0aClyZWFzb25zLnB1c2goJ0lOU1RJVFVUSU9OQUxfVkVDVE9SX1BFTkRJTkcnKTsKIGVsc2UgewogIGNvbnN0IHY9cmF3LmVtYmVkZGluZ3NbMF07YXNzZXJ0LmVxdWFsKHYudGVuYW50SWQsVEVOQU5UKTthc3NlcnQuZXF1YWwodi5jbGllbnRJZCxDTElFTlQpO2Fzc2VydC5lcXVhbCh2Lm93bmVyVXNlcklkLG51bGwpOwogIGFzc2VydC5lcXVhbCh2LnNvdXJjZVR5cGUsJ21lbW9yeV9pdGVtJyk7YXNzZXJ0LmVxdWFsKHYuc291cmNlSWQsaXRlbS5pZCk7YXNzZXJ0LmVxdWFsKHYubW9kZWwsJ2FtYXpvbi50aXRhbi1lbWJlZC10ZXh0LXYyOjAnKTsKICBhc3NlcnQuZXF1YWwodi5jb250ZW50SGFzaCxlLnByb2plY3Rpb25UZXh0U2hhMjU2KTthc3NlcnQuZXF1YWwodi5jb250ZW50VGV4dCxlLnRleHQpO2Fzc2VydC5lcXVhbCh2Lmhhc0VtYmVkZGluZyx0cnVlKTthc3NlcnQuZXF1YWwodi5kaW1lbnNpb25zLDEwMjQpOwogIGFzc2VydC5vayhEYXRlLnBhcnNlKGlzbyh2LmNyZWF0ZWRBdCkpPj1EYXRlLnBhcnNlKGlucHV0LndpbmRvd1N0YXJ0ZWRBdCkpO2Fzc2VydC5vayhEYXRlLnBhcnNlKGlzbyh2LnVwZGF0ZWRBdCkpPj1EYXRlLnBhcnNlKGlzbyh2LmNyZWF0ZWRBdCkpKTthc3NlcnQub2soRGF0ZS5wYXJzZShpc28odi51cGRhdGVkQXQpKTw9bm93KTsKIH0KIGlmKCFyYXcuam9icy5sZW5ndGgpcmVhc29ucy5wdXNoKCdFWEFDVF9PVVRCT1hfSk9CX1BFTkRJTkcnKTsKIGVsc2UgewogIGNvbnN0IGpvYj1yYXcuam9ic1swXTthc3NlcnQubWF0Y2goam9iLmlkLFVVSUQpO2Fzc2VydC5lcXVhbChqb2IudGVuYW50SWQsVEVOQU5UKTthc3NlcnQuZXF1YWwoam9iLmNsaW9NZW1vcnlJZCxjLmlkKTthc3NlcnQuZXF1YWwoam9iLm1lbW9yeUl0ZW1JZCxpdGVtLmlkKTsKICBhc3NlcnQuZXF1YWwoam9iLm9wZXJhdGlvbiwnaW5kZXhfbWVtb3J5X2l0ZW0nKTthc3NlcnQuZXF1YWwoam9iLmV4cGVjdGVkQ29udGVudEhhc2gsZS5wcm9qZWN0aW9uVGV4dFNoYTI1Nik7CiAgYXNzZXJ0LmVxdWFsKGlzbyhqb2IuZXhwZWN0ZWRTb3VyY2VWZXJzaW9uKSxpc28oYy51cGRhdGVkQXQpKTsKICBhc3NlcnQuZXF1YWwoam9iLmlkZW1wb3RlbmN5S2V5LGBpbmRleF9tZW1vcnlfaXRlbToke2MuaWR9OiR7aXNvKGMudXBkYXRlZEF0KX06JHtlLnByb2plY3Rpb25UZXh0U2hhMjU2fWApOwogIGFzc2VydC5lcXVhbChqb2IuYXR0ZW1wdHMsMCwnQkFDS0dST1VORF9BVFRFTVBUX09VVFNJREVfRkFTVF9QQVRIX0JPVU5EJyk7CiAgYXNzZXJ0Lm9rKERhdGUucGFyc2UoaXNvKGpvYi5jcmVhdGVkQXQpKT49RGF0ZS5wYXJzZShpbnB1dC53aW5kb3dTdGFydGVkQXQpKTthc3NlcnQub2soRGF0ZS5wYXJzZShpc28oam9iLmNyZWF0ZWRBdCkpPD1ub3cpOwogIGFzc2VydC5lcXVhbChqb2IubGVhc2VPd25lcixudWxsKTthc3NlcnQuZXF1YWwoam9iLmxlYXNlRXhwaXJlc0F0LG51bGwpOwogIGlmKGpvYi5zdGF0dXM9PT0ncGVuZGluZycpe2Fzc2VydC5lcXVhbChqb2IuY29tcGxldGVkQXQsbnVsbCk7YXNzZXJ0LmVxdWFsKGpvYi5sYXN0RXJyb3IsbnVsbCk7cmVhc29ucy5wdXNoKCdFWEFDVF9PVVRCT1hfUEVORElORycpO30KICBlbHNlIHsKICAgYXNzZXJ0LmVxdWFsKGpvYi5zdGF0dXMsJ2NvbXBsZXRlZCcpO2Fzc2VydC5lcXVhbChqb2IubGFzdEVycm9yLG51bGwpO2Fzc2VydC5vayhqb2IuY29tcGxldGVkQXQpOwogICBhc3NlcnQub2soRGF0ZS5wYXJzZShpc28oam9iLmNvbXBsZXRlZEF0KSk+PURhdGUucGFyc2UoaXNvKGpvYi5jcmVhdGVkQXQpKSk7YXNzZXJ0Lm9rKERhdGUucGFyc2UoaXNvKGpvYi5jb21wbGV0ZWRBdCkpPD1ub3cpOwogIH0KIH0KIGlmKHJlYXNvbnMubGVuZ3RoKXJldHVybntzdGF0dXM6J1dBSVQnLHJlYXNvbnN9OwogY29uc3Qgdj1yYXcuZW1iZWRkaW5nc1swXSxqb2I9cmF3LmpvYnNbMF07Y29uc3R7Y29udGVudFRleHQsLi4udmVjdG9yTWV0YWRhdGF9PXY7CiByZXR1cm57a2luZDonY2FzZTE0LWV4YWN0LXByb2plY3Rpb24tdGVybWluYWwtcHJvb2YnLHN0YXR1czonQk9USF9BUFBST1ZBTF9QUk9KRUNUSU9OX0JSQU5DSEVTX1BFUlNJU1RFRCcsc291cmNlU2hhOlNPVVJDRSwKICBjYXB0dXJlUnVuSWQ6aW5wdXQuY2FwdHVyZVJ1bklkLGFwcHJvdmFsRXZpZGVuY2VTaGEyNTY6aW5wdXQuYXBwcm92YWxFdmlkZW5jZVNoYTI1NixjYW5vbmljYWxPd25lcjpyYXcuY2Fub25pY2FsT3duZXIsCiAgd2luZG93U3RhcnRlZEF0OmlucHV0LndpbmRvd1N0YXJ0ZWRBdCxkZWFkbGluZUF0OmlucHV0LmRlYWRsaW5lQXQsb2JzZXJ2ZWRBdDpuZXcgRGF0ZShub3cpLnRvSVNPU3RyaW5nKCksCiAgY2xpbzp7aWQ6Yy5pZCx0ZW5hbnRJZDpjLnRlbmFudElkLGNsaWVudElkOmMuY2xpZW50SWQsb3duZXJVc2VySWQ6Yy5vd25lclVzZXJJZCxzY29wZTpjLnNjb3BlLHNvdXJjZTpjLnNvdXJjZSwKICAga2V5U2hhMjU2OnNoYShjLmtleSksdmFsdWVTaGEyNTY6c2hhKGMudmFsdWUpLGNyZWF0ZWRBdDppc28oYy5jcmVhdGVkQXQpLHVwZGF0ZWRBdDppc28oYy51cGRhdGVkQXQpLGhhc0xlZ2FjeUVtYmVkZGluZzp0cnVlLGxlZ2FjeURpbWVuc2lvbnM6MTUzNn0sCiAgaXRlbTp7aWQ6aXRlbS5pZCx0ZW5hbnRJZDppdGVtLnRlbmFudElkLGNsaWVudElkOml0ZW0uY2xpZW50SWQsb3duZXJVc2VySWQ6aXRlbS5vd25lclVzZXJJZCxyb3dWZXJzaW9uOml0ZW0ucm93VmVyc2lvbiwKICAgc3RhdHVzOml0ZW0uc3RhdHVzLGdvdmVybmVkU3RhdHVzOml0ZW0uZ292ZXJuZWRTdGF0dXMsc291cmNlVmVyc2lvbjppdGVtLnNvdXJjZVZlcnNpb24sc291cmNlQ29udGVudEhhc2g6aXRlbS5zb3VyY2VDb250ZW50SGFzaCwKICAgc2x1ZzppdGVtLnNsdWcsdGl0bGVTaGEyNTY6c2hhKGl0ZW0udGl0bGUpLHNlY3Rpb25zU2hhMjU2OnN0YWJsZUhhc2goaXRlbS5zZWN0aW9ucyl9LAogIGVtYmVkZGluZzp7Li4udmVjdG9yTWV0YWRhdGEsY29udGVudFRleHRTaGEyNTY6c2hhKGNvbnRlbnRUZXh0KSxjcmVhdGVkQXQ6aXNvKHYuY3JlYXRlZEF0KSx1cGRhdGVkQXQ6aXNvKHYudXBkYXRlZEF0KX0sCiAgb3V0Ym94OnsuLi5qb2IsZXhwZWN0ZWRTb3VyY2VWZXJzaW9uOmlzbyhqb2IuZXhwZWN0ZWRTb3VyY2VWZXJzaW9uKSxjcmVhdGVkQXQ6aXNvKGpvYi5jcmVhdGVkQXQpLGNvbXBsZXRlZEF0Omlzbyhqb2IuY29tcGxldGVkQXQpfSwKICBtYXRjaGluZ0luc3RpdHV0aW9uYWxWZWN0b3JSb3dzOjEsbWF0Y2hpbmdMZWdhY3lWZWN0b3JSb3dzOjEsZXhhY3RPdXRib3hSb3dzOjEsb3RoZXJPdXRib3hSb3dzOjAsCiAgcHJvdmlkZXJVc2FnZU1lYXN1cmVkOmZhbHNlLGFwcHJvdmFsQmlsbGVkQWN0dWFsTWljcm9zOm51bGwscHJvamVjdGlvbkRpc3BhdGNoZXNCeVRoaXNIZWxwZXI6MCwKICBwcm92aWRlckNhbGxzOjAsZGF0YWJhc2VXcml0ZXM6MCxyZXZpZXdEZWNpc2lvbnM6MCxhY2NlcHRhbmNlQXV0aG9yaXR5OmZhbHNlfTsKfQoKZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHBvbGxQcm9qZWN0aW9uKGlucHV0LHJlYWQsZW1pdCxjbG9jaz17bm93OigpPT5EYXRlLm5vdygpLHNsZWVwOm1zPT5uZXcgUHJvbWlzZShyPT5zZXRUaW1lb3V0KHIsbXMpKX0pewogdmFsaWRhdGVUZXJtaW5hbElucHV0KGlucHV0LGNsb2NrLm5vdygpKTtjb25zdCBzdG9wPU1hdGgubWluKGNsb2NrLm5vdygpKzYwMDAwLERhdGUucGFyc2UoaW5wdXQuZGVhZGxpbmVBdCkpO2xldCBhdHRlbXB0cz0wOwogd2hpbGUoYXR0ZW1wdHM8MTImJmNsb2NrLm5vdygpPHN0b3ApewogIC8vIE5ldmVyIGlzc3VlIGEgdHJhbnNhY3Rpb24gd2l0aCBhIGRlYWRsaW5lIGJleW9uZCB0aGlzIGxvY2FsIHBvbGxpbmcgd2luZG93LgogIGNvbnN0IHJlbWFpbmluZ0JlZm9yZVJlYWQ9c3RvcC1jbG9jay5ub3coKTtpZihyZW1haW5pbmdCZWZvcmVSZWFkPDEwMClicmVhazsKICBhdHRlbXB0cysrO2NvbnN0IHJhdz1hd2FpdCByZWFkKGlucHV0LHt0aW1lb3V0TXM6TWF0aC5taW4oNzAwMCxyZW1haW5pbmdCZWZvcmVSZWFkKSxzdG9wQXQ6c3RvcH0pOwogIGlmKGNsb2NrLm5vdygpPj1zdG9wKXRocm93IG5ldyBFcnJvcignQ0FTRTE0X1BST0pFQ1RJT05fTk9UX1RFUk1JTkFMX1dJVEhJTl9CT1VORCcpOwogIGNvbnN0IHJlc3VsdD12YWxpZGF0ZVByb2plY3Rpb25TbmFwc2hvdChpbnB1dCxyYXcsY2xvY2subm93KCkpOwogIGlmKHJlc3VsdC5zdGF0dXMhPT0nV0FJVCcpe2F3YWl0IGVtaXQoe3BoYXNlOidURVJNSU5BTCcsYXR0ZW1wdHMscHJvb2Y6cmVzdWx0fSk7cmV0dXJuIHJlc3VsdDt9CiAgYXdhaXQgZW1pdCh7cGhhc2U6J1BFTkRJTkcnLGF0dGVtcHQ6YXR0ZW1wdHMscmVhc29uczpyZXN1bHQucmVhc29ucyxwcm92aWRlckNhbGxzOjAsZGF0YWJhc2VXcml0ZXM6MH0pOwogIGNvbnN0IHJlbWFpbmluZz1zdG9wLWNsb2NrLm5vdygpO2lmKGF0dGVtcHRzPDEyJiZyZW1haW5pbmc+MClhd2FpdCBjbG9jay5zbGVlcChNYXRoLm1pbig1MDAwLHJlbWFpbmluZykpOwogfQogdGhyb3cgbmV3IEVycm9yKCdDQVNFMTRfUFJPSkVDVElPTl9OT1RfVEVSTUlOQUxfV0lUSElOX0JPVU5EJyk7Cn0KCi8vIE5hdGl2ZSBlbnRyeSBmb3IgdGhlIGJ5dGUtcGlubmVkIHBvc3RhcHByb3ZhbCBhZGFwdGVyLiBJbXBvcnRpbmcgbmV2ZXIgaW52b2tlcyBpdC4KZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bk5hdGl2ZVByb2plY3Rpb24oaW5wdXQsZW1pdCl7CiBsZXQgcHJpc21hOwogdHJ5ewogIGFzc2VydC5lcXVhbChwcm9jZXNzLmVudi5SRUxFQVNFX1NIQSxTT1VSQ0UpO2Fzc2VydC5lcXVhbChwcm9jZXNzLmVudi5HSVRfU0hBLFNPVVJDRSk7CiAgYXNzZXJ0LmVxdWFsKHByb2Nlc3MuZW52Lk1FUklfU1lOVEhFVElDX0ZJWFRVUkVfTkFNRVNQQUNFLCdtZXJpLWZvdW5kYXRpb24tMjAyNjA5MjgnKTsKICB2YWxpZGF0ZVRlcm1pbmFsSW5wdXQoaW5wdXQpOwogIGNvbnN0IGVudj17fTtmb3IoY29uc3Qga2V5IG9mIFsnUEFUSCcsJ0RCX0hPU1QnLCdEQl9QT1JUJywnREJfVVNFUicsJ0RCX1BBU1NXT1JEJywnREJfTkFNRScsJ1BHU1NMTU9ERSddKWlmKHByb2Nlc3MuZW52W2tleV0hPT11bmRlZmluZWQpZW52W2tleV09cHJvY2Vzcy5lbnZba2V5XTsKICBjb25zdCBjb21wb3NlZD1zcGF3blN5bmMocHJvY2Vzcy5leGVjUGF0aCxbJy9hcHAvYXBwcy9hcGkvc2NyaXB0cy9saWIvcGUtY29tcG9zZS1kYXRhYmFzZS11cmwuanMnXSx7ZW52LGVuY29kaW5nOid1dGY4JyxzdGRpbzpbJ2lnbm9yZScsJ3BpcGUnLCdpZ25vcmUnXSx0aW1lb3V0OjE1MDAwLG1heEJ1ZmZlcjo2NTUzNn0pOwogIGFzc2VydC5lcXVhbChjb21wb3NlZC5zdGF0dXMsMCk7YXNzZXJ0Lm1hdGNoKGNvbXBvc2VkLnN0ZG91dCwvXnBvc3RncmVzcWw6XC9cLy91KTtwcm9jZXNzLmVudi5EQVRBQkFTRV9VUkw9Y29tcG9zZWQuc3Rkb3V0LnRyaW0oKTsKICBjb25zdCByZXF1aXJlPWNyZWF0ZVJlcXVpcmUoJy9hcHAvYXBwcy9hcGkvcGFja2FnZS5qc29uJyk7CiAgY29uc3R7UHJpc21hU2VydmljZX09cmVxdWlyZSgnL2FwcC9hcHBzL2FwaS9kaXN0L3ByaXNtYS9wcmlzbWEuc2VydmljZS5qcycpOwogIGNvbnN0e01lbW9yeUF1dGhvcml6YXRpb25TZXJ2aWNlfT1yZXF1aXJlKCcvYXBwL2FwcHMvYXBpL2Rpc3QvbWVtb3J5L21lbW9yeS1hdXRob3JpemF0aW9uLnNlcnZpY2UuanMnKTsKICBjb25zdHtydW5XaXRoTWVtb3J5R292ZXJuYW5jZVRlbmFudH09cmVxdWlyZSgnL2FwcC9hcHBzL2FwaS9kaXN0L21lbW9yeS9tZW1vcnktZ292ZXJuYW5jZS10ZW5hbnQtc2NvcGUuanMnKTsKICBjb25zdHtyZWFkQ2FzZTE0Rml4dHVyZUV2aWRlbmNlSW5UeH09cmVxdWlyZSgnL2FwcC9hcHBzL2FwaS9kaXN0L21lbW9yeS9jYXNlMTQtZml4dHVyZS1ldmlkZW5jZS5qcycpOwogIHByaXNtYT1uZXcgUHJpc21hU2VydmljZSgpO2NvbnN0IGF1dGhvcml6YXRpb249bmV3IE1lbW9yeUF1dGhvcml6YXRpb25TZXJ2aWNlKHByaXNtYSk7YXdhaXQgcHJpc21hLiRjb25uZWN0KCk7CiAgY29uc3QgY3R4PXt0ZW5hbnRJZDpURU5BTlQsdGVuYW50U2x1ZzonbWVyaS1mb3VuZGF0aW9uLTIwMjYwOTI4LXQxJyx1c2VySWQ6UFJJWUEsY2xlcmtVc2VySWQ6J3VzZXJfM0p3MkcyamJ5eURscnJnNnpDTmQ0Z1lVRGZIJyxyb2xlOid1c2VyX2FkbWluJ307CiAgY29uc3QgcmVhZD1hc3luYyhfaW5wdXQse3RpbWVvdXRNc30pPT5ydW5XaXRoTWVtb3J5R292ZXJuYW5jZVRlbmFudChURU5BTlQsKCk9PnByaXNtYS53aXRoVGVuYW50VXNlcihURU5BTlQsUFJJWUEsYXN5bmMgdHg9PnsKICAgYXNzZXJ0Lm9rKE51bWJlci5pc0ludGVnZXIodGltZW91dE1zKSYmdGltZW91dE1zPj0xMDAmJnRpbWVvdXRNczw9NzAwMCk7CiAgIGF3YWl0IHR4LiRleGVjdXRlUmF3VW5zYWZlKGBTRVQgTE9DQUwgc3RhdGVtZW50X3RpbWVvdXQ9JyR7TWF0aC5taW4oNDAwMCx0aW1lb3V0TXMpfW1zJ2ApO2F3YWl0IHR4LiRleGVjdXRlUmF3VW5zYWZlKGBTRVQgTE9DQUwgbG9ja190aW1lb3V0PScke01hdGgubWluKDIwMDAsdGltZW91dE1zKX1tcydgKTsKICAgY29uc3QgY2Fub25pY2FsT3duZXI9YXdhaXQgcmVhZENhc2UxNEZpeHR1cmVFdmlkZW5jZUluVHgodHgsY3R4LGF1dGhvcml6YXRpb24sQ0FORElEQVRFKTsKICAgYXNzZXJ0LmRlZXBFcXVhbChjYW5vbmljYWxPd25lcixpbnB1dC5hcHByb3ZlZE93bmVyKTsKICAgY29uc3QgY2xpbz1hd2FpdCB0eC4kcXVlcnlSYXdVbnNhZmUoYFNFTEVDVCBpZDo6dGV4dCx0ZW5hbnRfaWQ6OnRleHQgQVMgInRlbmFudElkIixjbGllbnRfaWQ6OnRleHQgQVMgImNsaWVudElkIixvd25lcl91c2VyX2lkOjp0ZXh0IEFTICJvd25lclVzZXJJZCIsc2NvcGUsa2V5LHZhbHVlLHNvdXJjZSxjcmVhdGVkX2F0IEFTICJjcmVhdGVkQXQiLHVwZGF0ZWRfYXQgQVMgInVwZGF0ZWRBdCIsZW1iZWRkaW5nIElTIE5PVCBOVUxMIEFTICJoYXNMZWdhY3lFbWJlZGRpbmciLENBU0UgV0hFTiBlbWJlZGRpbmcgSVMgTlVMTCBUSEVOIE5VTEwgRUxTRSB2ZWN0b3JfZGltcyhlbWJlZGRpbmcpIEVORCBBUyAibGVnYWN5RGltZW5zaW9ucyIgRlJPTSBjbGlvX21lbW9yeSBXSEVSRSB0ZW5hbnRfaWQ9JDE6OnV1aWQgQU5EIGlkPSQyOjp1dWlkIExJTUlUIDJgLFRFTkFOVCxjYW5vbmljYWxPd25lci5pdGVtLmNsaW9NZW1vcnlJZCk7CiAgIGNvbnN0IGl0ZW1zPWF3YWl0IHR4LiRxdWVyeVJhd1Vuc2FmZShgU0VMRUNUIGlkOjp0ZXh0LHRlbmFudF9pZDo6dGV4dCBBUyAidGVuYW50SWQiLGNsaWVudF9pZDo6dGV4dCBBUyAiY2xpZW50SWQiLG93bmVyX3VzZXJfaWQ6OnRleHQgQVMgIm93bmVyVXNlcklkIixzdGF0dXMsZ292ZXJuZWRfc3RhdHVzIEFTICJnb3Zlcm5lZFN0YXR1cyIsc291cmNlX3ZlcnNpb24gQVMgInNvdXJjZVZlcnNpb24iLHNvdXJjZV9jb250ZW50X2hhc2ggQVMgInNvdXJjZUNvbnRlbnRIYXNoIix4bWluOjp0ZXh0IEFTICJyb3dWZXJzaW9uIixzbHVnLHRpdGxlLHNlY3Rpb25zX2pzb25iIEFTIHNlY3Rpb25zIEZST00gbWVtb3J5X2l0ZW1zIFdIRVJFIHRlbmFudF9pZD0kMTo6dXVpZCBBTkQgaWQ9JDI6OnV1aWQgTElNSVQgMmAsVEVOQU5ULGNhbm9uaWNhbE93bmVyLml0ZW0uaWQpOwogICBjb25zdCBlbWJlZGRpbmdzPWF3YWl0IHR4LiRxdWVyeVJhd1Vuc2FmZShgU0VMRUNUIHRlbmFudF9pZDo6dGV4dCBBUyAidGVuYW50SWQiLGNsaWVudF9pZDo6dGV4dCBBUyAiY2xpZW50SWQiLG93bmVyX3VzZXJfaWQ6OnRleHQgQVMgIm93bmVyVXNlcklkIixzb3VyY2VfdHlwZSBBUyAic291cmNlVHlwZSIsc291cmNlX2lkIEFTICJzb3VyY2VJZCIsbW9kZWwsY29udGVudF9oYXNoIEFTICJjb250ZW50SGFzaCIsY29udGVudF90ZXh0IEFTICJjb250ZW50VGV4dCIsZW1iZWRkaW5nIElTIE5PVCBOVUxMIEFTICJoYXNFbWJlZGRpbmciLHZlY3Rvcl9kaW1zKGVtYmVkZGluZykgQVMgZGltZW5zaW9ucyxjcmVhdGVkX2F0IEFTICJjcmVhdGVkQXQiLHVwZGF0ZWRfYXQgQVMgInVwZGF0ZWRBdCIgRlJPTSBjb250ZXh0X2VtYmVkZGluZ3MgV0hFUkUgdGVuYW50X2lkPSQxOjp1dWlkIEFORCBzb3VyY2VfdHlwZT0nbWVtb3J5X2l0ZW0nIEFORCBzb3VyY2VfaWQ9JDIgTElNSVQgM2AsVEVOQU5ULGNhbm9uaWNhbE93bmVyLml0ZW0uaWQpOwogICBjb25zdCBqb2JzPWF3YWl0IHR4LiRxdWVyeVJhd1Vuc2FmZShgU0VMRUNUIGlkOjp0ZXh0LHRlbmFudF9pZDo6dGV4dCBBUyAidGVuYW50SWQiLG1lbW9yeV9pdGVtX2lkOjp0ZXh0IEFTICJtZW1vcnlJdGVtSWQiLGNsaW9fbWVtb3J5X2lkOjp0ZXh0IEFTICJjbGlvTWVtb3J5SWQiLG9wZXJhdGlvbixpZGVtcG90ZW5jeV9rZXkgQVMgImlkZW1wb3RlbmN5S2V5IixzdGF0dXMsYXR0ZW1wdHMsY3JlYXRlZF9hdCBBUyAiY3JlYXRlZEF0Iixjb21wbGV0ZWRfYXQgQVMgImNvbXBsZXRlZEF0IixsYXN0X2Vycm9yIEFTICJsYXN0RXJyb3IiLGV4cGVjdGVkX3NvdXJjZV92ZXJzaW9uIEFTICJleHBlY3RlZFNvdXJjZVZlcnNpb24iLGV4cGVjdGVkX2NvbnRlbnRfaGFzaCBBUyAiZXhwZWN0ZWRDb250ZW50SGFzaCIsbGVhc2Vfb3duZXI6OnRleHQgQVMgImxlYXNlT3duZXIiLGxlYXNlX2V4cGlyZXNfYXQgQVMgImxlYXNlRXhwaXJlc0F0IiBGUk9NIG1lbW9yeV9jbGVhbnVwX291dGJveCBXSEVSRSB0ZW5hbnRfaWQ9JDE6OnV1aWQgQU5EIChtZW1vcnlfaXRlbV9pZD0kMjo6dXVpZCBPUiBjbGlvX21lbW9yeV9pZD0kMzo6dXVpZCkgTElNSVQgM2AsVEVOQU5ULGNhbm9uaWNhbE93bmVyLml0ZW0uaWQsY2Fub25pY2FsT3duZXIuaXRlbS5jbGlvTWVtb3J5SWQpOwogICByZXR1cm57Y2Fub25pY2FsT3duZXIsY2xpbyxpdGVtcyxlbWJlZGRpbmdzLGpvYnN9OwogIH0se3RpbWVvdXRNc30pKTsKICAvLyBCb3VuZGVkIHJlY2VpcHRzIGNhcnJ5IGFjdHVhbCBuYXJyb3cgcm93IHByb29mcywgbm90IHRlbmFudCBzZXR0aW5ncyBvciB2ZWN0b3IgdmFsdWVzLgogIGF3YWl0IGVtaXQoe3BoYXNlOidCRUdJTicsc291cmNlU2hhOlNPVVJDRSxpbnB1dENvbnRlbnRTaGEyNTY6c3RhYmxlSGFzaChpbnB1dCksY2FwdHVyZVJ1bklkOmlucHV0LmNhcHR1cmVSdW5JZCxhcHByb3ZhbEV2aWRlbmNlU2hhMjU2OmlucHV0LmFwcHJvdmFsRXZpZGVuY2VTaGEyNTZ9KTsKICBjb25zdCBwcm9vZj1hd2FpdCBwb2xsUHJvamVjdGlvbihpbnB1dCxyZWFkLGVtaXQpOwogIGF3YWl0IGVtaXQoe3BoYXNlOidFTkQnLHByb29mU2hhMjU2OnN0YWJsZUhhc2gocHJvb2YpLHByb3ZpZGVyQ2FsbHM6MCxkYXRhYmFzZVdyaXRlczowLGFjY2VwdGFuY2VBdXRob3JpdHk6ZmFsc2V9KTsKICByZXR1cm4gcHJvb2Y7CiB9Y2F0Y2h7YXdhaXQgZW1pdCh7cGhhc2U6J0ZBSUxVUkUnLGNvZGU6J0NBU0UxNF9QUk9KRUNUSU9OX1RFUk1JTkFMX1JFQURfRkFJTEVEJyxwcm92aWRlckNhbGxzOjAsZGF0YWJhc2VXcml0ZXM6MCxhdXRvbWF0aWNSZXRyeUFsbG93ZWQ6ZmFsc2UsYWNjZXB0YW5jZUF1dGhvcml0eTpmYWxzZX0pO3Rocm93IG5ldyBFcnJvcignQ0FTRTE0X1BST0pFQ1RJT05fVEVSTUlOQUxfUkVBRF9GQUlMRUQnKTt9CiBmaW5hbGx5e2F3YWl0IHByaXNtYT8uJGRpc2Nvbm5lY3QoKTt9Cn0KYXN5bmMgZnVuY3Rpb24gbWFpbigpewogY29uc3QgZW1pdD12PT5uZXcgUHJvbWlzZSgocmVzb2x2ZSxyZWplY3QpPT5wcm9jZXNzLnN0ZG91dC53cml0ZSgnQzJfQ0FTRTE0X1BST0pFQ1RJT05fUkVBRCAnK0pTT04uc3RyaW5naWZ5KHYpKydcbicsZT0+ZT9yZWplY3QoZSk6cmVzb2x2ZSgpKSk7CiB0cnl7CiAgY29uc3QgYnl0ZXM9QnVmZmVyLmZyb20ocHJvY2Vzcy5lbnYuQzJfQ0FTRTE0X1BST0pFQ1RJT05fSU5QVVRfQjY0Pz8nJywnYmFzZTY0Jyk7YXNzZXJ0Lm9rKGJ5dGVzLmxlbmd0aD4wJiZieXRlcy5sZW5ndGg8MzI3NjgpOwogIGFzc2VydC5tYXRjaChwcm9jZXNzLmVudi5DMl9DQVNFMTRfUFJPSkVDVElPTl9JTlBVVF9TSEEyNTY/PycnLEhBU0gpO2Fzc2VydC5lcXVhbChzaGEoYnl0ZXMpLHByb2Nlc3MuZW52LkMyX0NBU0UxNF9QUk9KRUNUSU9OX0lOUFVUX1NIQTI1Nik7CiAgYXdhaXQgcnVuTmF0aXZlUHJvamVjdGlvbihKU09OLnBhcnNlKGJ5dGVzKSxlbWl0KTsKIH1jYXRjaHtwcm9jZXNzLmV4aXRDb2RlPTE7fQp9CmlmKHByb2Nlc3MuYXJndlsxXT9pbXBvcnQubWV0YS51cmw9PT1wYXRoVG9GaWxlVVJMKHJlc29sdmUocHJvY2Vzcy5hcmd2WzFdKSkuaHJlZjovXC9cW2V2YWxcZCtcXSQvdS50ZXN0KGltcG9ydC5tZXRhLnVybCkpYXdhaXQgbWFpbigpOwo=';

export const PIN = Object.freeze({
  source: 'c0f393f863bf73bd4e65e7a94e17c073e7be021e',
  namespace: 'meri-foundation-20260928',
  tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
  tenantSlug: 'meri-foundation-20260928-t1',
  reviewerId: 'fb218bf5-2674-4ced-bca3-7a5d0c01592f',
  reviewerClerkId: 'user_3Jw2G2jbyyDlrrg6zCNd4gYUDfH',
  proposerId: 'b1f758fc-17bd-40f8-bef2-fa2d2380300f',
  clientId: '41f9ec63-3963-479f-b747-59a3767ef44b',
  fixtureInstanceId: 'dee4e90e-8e91-4782-9488-10b8e52a2146',
  candidateId: '6f4545a1-dcd5-5eba-8606-db2043b238ac',
  recipeSha256: '1668649c84550f701faea8e30617da11c944c84caeb99965afa311acd017e593',
  manifestContentSha256: '5deda70f94698a8f8ed82d40fa804d16ae2e39a091012af0d70203a0e1b5fc14',
  setupReceiptSha256: 'c2c80bdef51e6b8b22d13c809e77e76c61eb680fa10aca88372f258d53a155f8',
  seedPlanSha256: '42ed4d5a6466c9834a9d578092b98f07039808cf424a6a77095aca22202c21f2',
  ownershipMarkerSha256: '48b95413d7b876a412e3c5352ac4e3fecfea5eb8b260e2cd327736829ee1faab',
  payloadSha256: '1b2333f97623789682efa51f479a8a0a452a2c4d1181b121437c51f4f0be499e',
  rateEvidenceSha256: '1c9106e5d98f73b061f0de9918bf33c8fb28b0f0bc5be5ae4bc7d20e0da2a348',
  rateEvidenceExpiresAt: '2026-10-04T11:09:44.838Z',
});
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
export const stableHash = v => hash(JSON.stringify(stable(v)));
const keys = (v, expected) => assert.deepEqual(Object.keys(v).sort(), [...expected].sort());
const sha = value => assert.match(value, HASH);
const zero = r => { assert.equal(r.sharedCorpusWrites, 0); assert.equal(r.approvalDecisions, 0); assert.equal(r.liveAcceptance, 'NOT_RUN'); };

export function validateInput(input, now = Date.now()) {
  keys(input, ['kind', 'version', 'sourceSha', 'captureRunId', 'ctx', 'clientId', 'approvalEvidenceSha256', 'approvedOwner', 'approvalWindow', 'limits', 'rateEvidence']);
  assert.equal(input.kind, 'case14-postapproval-native-setup-input'); assert.equal(input.version, 1);
  assert.equal(input.sourceSha, PIN.source); assert.match(input.captureRunId, UUID);
  keys(input.approvalWindow, ['startedAtMs','deadlineAtMs']);
  const window = input.approvalWindow;
  assert.ok(Number.isSafeInteger(window.startedAtMs) && Number.isSafeInteger(window.deadlineAtMs));
  assert.ok(window.startedAtMs <= now && now < window.deadlineAtMs && window.deadlineAtMs - window.startedAtMs <= 900000, 'APPROVAL_WINDOW_INVALID_OR_EXPIRED');
  keys(input.ctx, ['tenantId', 'tenantSlug', 'userId', 'clerkUserId', 'role']);
  assert.deepEqual(input.ctx, { tenantId: PIN.tenantId, tenantSlug: PIN.tenantSlug,
    userId: PIN.reviewerId, clerkUserId: PIN.reviewerClerkId, role: 'user_admin' });
  assert.equal(input.clientId, PIN.clientId); sha(input.approvalEvidenceSha256);
  const o = input.approvedOwner;
  keys(o, ['kind','schemaVersion','caseId','fixtureNamespace','fixtureVersion','fixtureInstanceId',
    'manifestContentSha256','recipeSha256','seedPlanSha256','setupReceiptSha256','tenantId','clientId',
    'proposerUserId','reviewerUserId','reviewerRole','logicalSourceId','candidateId','candidateRowVersion',
    'revision','ownershipMarkerSha256','payloadSha256','text','state','item','decision','currentVerifySha256']);
  const { currentVerifySha256, ...body } = o; assert.equal(currentVerifySha256, stableHash(body));
  assert.equal(o.kind, 'meri-case14-current-memory-owner'); assert.equal(o.schemaVersion, 1);
  assert.equal(o.caseId, '14'); assert.equal(o.fixtureNamespace, PIN.namespace);
  assert.equal(o.fixtureVersion, 'meri-live-v1-2026-09-26.1');
  for (const field of ['fixtureInstanceId','recipeSha256','manifestContentSha256','setupReceiptSha256','tenantId','clientId','candidateId','seedPlanSha256','ownershipMarkerSha256','payloadSha256']) assert.equal(o[field], PIN[field]);
  assert.equal(o.proposerUserId, PIN.proposerId); assert.equal(o.reviewerUserId, PIN.reviewerId);
  assert.equal(o.reviewerRole, 'user_admin'); assert.equal(o.logicalSourceId, 'MEM-PROPOSAL-14');
  assert.equal(o.revision, 1); assert.equal(o.state, 'approved');
  assert.equal(o.text, 'Synthetic Aster candidate for approval'); assert.match(o.candidateRowVersion, /^\d+$/u);
  for (const field of ['seedPlanSha256','ownershipMarkerSha256','payloadSha256']) sha(o[field]);
  keys(o.item, ['id','clioMemoryId','rowVersion','sourceVersion','contentSha256','status','governedStatus']);
  assert.match(o.item.id, UUID); assert.match(o.item.clioMemoryId, UUID); assert.match(o.item.rowVersion, /^\d+$/u);
  assert.equal(o.item.sourceVersion, 'candidate:' + PIN.candidateId); sha(o.item.contentSha256);
  assert.equal(o.item.status, 'active'); assert.equal(o.item.governedStatus, 'active');
  keys(o.decision, ['transitionAuditId','actorUserId','decision']); assert.match(o.decision.transitionAuditId, UUID);
  assert.equal(o.decision.actorUserId, PIN.reviewerId); assert.equal(o.decision.decision, 'approved');
  keys(input.limits, ['maxAttempts','maxTokens','maxCostMicros']);
  assert.equal(input.limits.maxAttempts, 32); assert.equal(input.limits.maxTokens, 500000);
  assert.equal(input.limits.maxCostMicros, 14000000);
  assert.equal(stableHash(input.rateEvidence), PIN.rateEvidenceSha256);
  assert.equal(input.rateEvidence.expiresAt, PIN.rateEvidenceExpiresAt);
  assert.ok(Date.parse(input.rateEvidence.observedAt) <= now);
  // 30-minute policy lifetime plus 15 minutes for setup/collection. Never extend evidence.
  assert.ok(Date.parse(input.rateEvidence.expiresAt) > now + 45 * 60000, 'RATE_EVIDENCE_LESS_THAN_45_MINUTES');
  return input;
}

const PLAN_KEYS = ['kind','schemaVersion','caseId','captureRunId','tenantId','actorUserId','clientId','tenantRowVersion',
  'priorSettingsSha256','approvedOwnerSha256','physicalMapSha256','sharedCorpusWrites','approvalDecisions','liveAcceptance','planSha256'];
const BIND_KEYS = ['status','operationId','binding','sourceMap','seedReceipt','resetReceipt','sharedCorpusWrites','approvalDecisions','synthesisSubmissionCount','liveAcceptance'];
const BUDGET_PLAN_KEYS = ['status','caseId','captureRunId','currentVerifySha256','captureBindingSha256','priorQualificationSha256','tenantRowVersion','liveAcceptance'];
const INSTALL_KEYS = ['status','tenantId','clientId','captureRunId','currentVerifySha256','captureBindingSha256','qualificationSha256',
  'priorQualificationSha256','tenantRowVersion','maxCostMicros','rateEvidenceSha256','rateEvidenceExpiresAt','liveAcceptance'];
const STAGES = Object.freeze([
  { name: 'recall-plan', cli: 'meri-case14-recall-setup.mjs', mode: 'plan', inputEnv: 'MERI_CASE14_RECALL_SETUP_INPUT', resultKeys: PLAN_KEYS, writes: false },
  { name: 'recall-bind', cli: 'meri-case14-recall-setup.mjs', mode: 'bind', inputEnv: 'MERI_CASE14_RECALL_SETUP_INPUT', resultKeys: BIND_KEYS, writes: true },
  { name: 'budget-plan', cli: 'meri-capture-provider-budget.mjs', mode: 'plan', inputEnv: 'MERI_CAPTURE_PROVIDER_BUDGET_INPUT', resultKeys: BUDGET_PLAN_KEYS, writes: false },
  { name: 'budget-install', cli: 'meri-capture-provider-budget.mjs', mode: 'install', inputEnv: 'MERI_CAPTURE_PROVIDER_BUDGET_INPUT', resultKeys: INSTALL_KEYS, writes: true },
]);
function sourceMap(input) { return { 'MEM-PROPOSAL-14': { frozenFixtureId: 'MEM-PROPOSAL-14', kind: 'memory',
  physicalId: input.approvedOwner.item.id, tenantPhysicalId: PIN.tenantId, clientPhysicalId: PIN.clientId,
  version: 'candidate:' + PIN.candidateId } }; }
function verifyReceiptHash(receipt, kind) {
  assert.equal(receipt.kind, kind); const { contentSha256, ...body } = receipt;
  assert.equal(contentSha256, stableHash(body));
}

// Injection is a local test seam only. main() always supplies the fixed native implementation.
export async function sequence(input, invoke, frame, now = Date.now, project) {
  validateInput(input, now());
  const scope = { ctx: input.ctx, caseId: '14', clientId: input.clientId, captureRunId: input.captureRunId };
  const budgetScope = { target: 'capiro-dev', fixtureNamespace: PIN.namespace, caseId: '14', ctx: input.ctx, clientId: input.clientId };
  const results = {}, phaseInputs = {}, completed = [];
  let active = {name:'projection-terminal',writes:false};
  try {
    assert.equal(typeof project, 'function', 'NATIVE_TERMINAL_PROJECTION_ENTRY_REQUIRED');
    const projectionInput = {kind:'case14-projection-terminal-read-input',version:1,sourceSha:PIN.source,
      captureRunId:input.captureRunId,approvalEvidenceSha256:input.approvalEvidenceSha256,approvedOwner:input.approvedOwner,
      windowStartedAt:new Date(input.approvalWindow.startedAtMs).toISOString(),deadlineAt:new Date(input.approvalWindow.deadlineAtMs).toISOString()};
    await frame({phase:'INTENT',stage:active.name,ownerInputSha256:stableHash(projectionInput),mayWriteSettings:false,automaticRetryAllowed:false});
    const projection = await project(projectionInput, receipt => frame({phase:'PROJECTION_READ_RECEIPT',receipt}));
    validateInput(input, now());
    assert.equal(projection.kind,'case14-exact-projection-terminal-proof');
    assert.equal(projection.status,'BOTH_APPROVAL_PROJECTION_BRANCHES_PERSISTED');
    assert.equal(projection.sourceSha,PIN.source);assert.equal(projection.captureRunId,input.captureRunId);
    assert.equal(projection.approvalEvidenceSha256,input.approvalEvidenceSha256);assert.deepEqual(projection.canonicalOwner,input.approvedOwner);
    assert.equal(projection.windowStartedAt,projectionInput.windowStartedAt);assert.equal(projection.deadlineAt,projectionInput.deadlineAt);
    assert.ok(Date.parse(projection.observedAt)>=input.approvalWindow.startedAtMs&&Date.parse(projection.observedAt)<=now());
    assert.equal(projection.clio.legacyDimensions,1536);assert.equal(projection.embedding.dimensions,1024);
    assert.equal(projection.matchingLegacyVectorRows,1);assert.equal(projection.matchingInstitutionalVectorRows,1);
    assert.equal(projection.exactOutboxRows,1);assert.equal(projection.otherOutboxRows,0);
    for(const k of ['providerCalls','databaseWrites','reviewDecisions','projectionDispatchesByThisHelper'])assert.equal(projection[k],0);
    assert.equal(projection.acceptanceAuthority,false);assert.equal(projection.providerUsageMeasured,false);assert.equal(projection.approvalBilledActualMicros,null);
    results['projection-terminal']=projection;completed.push('projection-terminal');
    await frame({phase:'VERIFIED',stage:'projection-terminal',receiptSha256:stableHash(projection),proof:projection});
    for (const stage of STAGES) {
      active = stage;
      // Recheck expiry before each possible settings write.
      validateInput(input, now());
      let body;
      if (stage.name === 'recall-plan') body = scope;
      if (stage.name === 'recall-bind') body = { ...scope, expectedPlanSha256: results['recall-plan'].planSha256,
        confirmation: 'BIND_EXISTING_CASE14_CANONICAL_APPROVAL' };
      if (stage.name === 'budget-plan') body = budgetScope;
      if (stage.name === 'budget-install') {
        const p = results['budget-plan'];
        body = { ...budgetScope, qualification: { version: 1, caseId: '14', captureRunId: input.captureRunId,
          currentVerifySha256: p.currentVerifySha256, rateEvidenceSha256: PIN.rateEvidenceSha256,
          rateEvidenceExpiresAt: PIN.rateEvidenceExpiresAt, priceKind: input.rateEvidence.priceKind,
          ...input.limits, rates: input.rateEvidence.rates }, rateEvidence: input.rateEvidence,
          expectedCurrentVerifySha256: p.currentVerifySha256, expectedCaptureBindingSha256: p.captureBindingSha256,
          expectedPriorQualificationSha256: p.priorQualificationSha256, expectedTenantRowVersion: p.tenantRowVersion };
      }
      phaseInputs[stage.name] = body;
      await frame({ phase: 'INTENT', stage: stage.name, ownerInputSha256: stableHash(body), mayWriteSettings: stage.writes, automaticRetryAllowed: false });
      const child = await invoke(stage, body);
      let result = null;
      if (child.bytes?.length > 0 && child.bytes.length <= 32768) {
        try {
          result = JSON.parse(child.bytes.toString('utf8'));
          // Only known CLI receipt shapes are permitted in the cloud log. Never print child stdout/stderr.
          if (result.status === 'FAILED') { keys(result, ['status','code','liveAcceptance']); assert.match(result.code, /^meri_capture_provider_budget_[A-Za-z0-9_]+$/u); }
          else keys(result, stage.resultKeys);
          await frame({ phase: 'RECEIPT', stage: stage.name, childExitCode: child.status,
            sha256: hash(child.bytes), bytes: child.bytes.length, data: child.bytes.toString('base64') });
        } catch { result = null; }
      }
      assert.equal(child.status, 0, 'NATIVE_CHILD_FAILED_OR_UNKNOWN'); assert.ok(result, 'NATIVE_RECEIPT_MISSING_OR_INVALID');
      validateInput(input, now());
      assert.equal(result.liveAcceptance, 'NOT_RUN');
      if (stage.name === 'recall-plan') {
        const { planSha256, ...p } = result; assert.equal(planSha256, stableHash(p));
        assert.equal(p.kind, 'meri-case14-recall-binding-plan'); assert.equal(p.schemaVersion, 1); zero(p);
        for (const [k, value] of Object.entries({ caseId: '14', captureRunId: input.captureRunId,
          tenantId: PIN.tenantId, actorUserId: PIN.reviewerId, clientId: PIN.clientId,
          approvedOwnerSha256: input.approvedOwner.currentVerifySha256, physicalMapSha256: stableHash(sourceMap(input)) })) assert.equal(p[k], value);
        sha(p.priorSettingsSha256); assert.match(p.tenantRowVersion, /^\d+$/u);
      } else if (stage.name === 'recall-bind') {
        assert.equal(result.status, 'CASE14_RECALL_BOUND'); zero(result); assert.equal(result.synthesisSubmissionCount, 0);
        assert.match(result.operationId, UUID); assert.deepEqual(result.sourceMap, sourceMap(input));
        verifyReceiptHash(result.seedReceipt, 'meri-synthetic-fixture-seed-receipt');
        verifyReceiptHash(result.resetReceipt, 'meri-synthetic-fixture-reset-receipt');
        const seed = result.seedReceipt, reset = result.resetReceipt;
        assert.equal(seed.owner, 'meri_case14_canonical_approval_v1'); assert.equal(reset.owner, seed.owner);
        for (const receipt of [seed, reset]) assert.equal(receipt.operationId, result.operationId);
        for (const [k, value] of Object.entries({ tenantId: PIN.tenantId, actorUserId: PIN.reviewerId, clientId: PIN.clientId,
          caseId: '14', captureRunId: input.captureRunId, approvedOwnerSha256: input.approvedOwner.currentVerifySha256,
          physicalMapSha256: stableHash(sourceMap(input)), setupReceiptSha256: PIN.setupReceiptSha256,
          transitionAuditId: input.approvedOwner.decision.transitionAuditId })) assert.equal(seed[k], value);
        assert.equal(reset.scope, 'replace_owned_capture_binding_only_after_canonical_approval'); assert.equal(reset.sharedCorpusWrites, 0);
        assert.equal(reset.priorSettingsSha256, results['recall-plan'].priorSettingsSha256);
        assert.deepEqual(result.binding, { caseId: '14', captureRunId: input.captureRunId,
          fixtureVersion: input.approvedOwner.fixtureVersion, physicalMapSha256: stableHash(sourceMap(input)),
          seedReceiptId: 'meri-synthetic-fixture-seed-receipt:sha256:' + seed.contentSha256,
          resetReceiptId: 'meri-synthetic-fixture-reset-receipt:sha256:' + reset.contentSha256,
          fixtureNamespace: PIN.namespace, actorUserId: PIN.reviewerId, clientId: PIN.clientId,
          currentVerifySha256: stableHash({ kind: 'meri-case14-current-approved-source', schemaVersion: 1,
            canonicalOwner: input.approvedOwner, seedReceiptSha256: seed.contentSha256, resetReceiptSha256: reset.contentSha256 }) });
      } else if (stage.name === 'budget-plan') {
        assert.equal(result.status, 'READY_FOR_RATE_QUALIFICATION'); assert.equal(result.caseId, '14');
        assert.equal(result.captureRunId, input.captureRunId);
        assert.equal(result.currentVerifySha256, results['recall-bind'].binding.currentVerifySha256);
        assert.equal(result.captureBindingSha256, stableHash(results['recall-bind'].binding));
        assert.equal(result.priorQualificationSha256, stableHash(null)); assert.match(result.tenantRowVersion, /^\d+$/u);
      } else {
        assert.equal(result.status, 'PROVIDER_QUALIFICATION_INSTALLED');
        for (const [k, value] of Object.entries({ tenantId: PIN.tenantId, clientId: PIN.clientId, captureRunId: input.captureRunId,
          currentVerifySha256: body.expectedCurrentVerifySha256, captureBindingSha256: body.expectedCaptureBindingSha256,
          priorQualificationSha256: body.expectedPriorQualificationSha256, qualificationSha256: stableHash(body.qualification),
          maxCostMicros: input.limits.maxCostMicros, rateEvidenceSha256: PIN.rateEvidenceSha256,
          rateEvidenceExpiresAt: PIN.rateEvidenceExpiresAt })) assert.equal(result[k], value);
        assert.match(result.tenantRowVersion, /^\d+$/u);
      }
      results[stage.name] = result; completed.push(stage.name);
      await frame({ phase: 'VERIFIED', stage: stage.name, receiptSha256: hash(child.bytes) });
    }
    const value = { kind: 'case14-postapproval-native-setup', status: 'RECALL_BOUND_AND_BUDGET_INSTALLED',
      preparedBy: 'Codex', sourceSha: PIN.source, captureRunId: input.captureRunId,
      approvalEvidenceSha256: input.approvalEvidenceSha256, inputContentSha256: stableHash(input),
      approvalWindow:input.approvalWindow,phaseInputs, results, completed, adapterProviderCalls: 0, approvalProviderEffects: 'TERMINAL_PERSISTENCE_VERIFIED_BILLED_ACTUAL_UNMEASURED',
      reviewDecisions: 0, synthesisSubmissions: 0, aggregateJournalMutations: 0, liveAcceptance: 'NOT_RUN', acceptanceAuthority: false };
    await frame({ phase: 'COMPLETE', value }); return value;
  } catch {
    await frame({ phase: 'FAILURE', stage: active?.name ?? null, completed,
      code: 'CASE14_POSTAPPROVAL_SETUP_FAILED', automaticRetryAllowed: false,
      effectStatus: completed.includes('recall-bind') || active?.writes ? 'RECONCILE_PARTIAL_NATIVE_SETUP_NO_RETRY' : 'NO_NATIVE_WRITE_DISPATCHED',
      liveAcceptance: 'NOT_RUN', acceptanceAuthority: false });
    throw new Error('CASE14_POSTAPPROVAL_SETUP_FAILED');
  }
}

async function main() {
  let inputByteSha256 = null;
  const emit = value => new Promise((resolve, reject) => process.stdout.write('C2_CASE14_POSTAPPROVAL ' + JSON.stringify({sourceSha: PIN.source, inputByteSha256, ...value}) + '\n', e => e ? reject(e) : resolve()));
  try {
    assert.equal(process.env.RELEASE_SHA, PIN.source); assert.equal(process.env.GIT_SHA, PIN.source);
    assert.equal(process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE, PIN.namespace);
    const bytes = Buffer.from(process.env.C2_CASE14_POSTAPPROVAL_INPUT_B64 ?? '', 'base64');
    assert.ok(bytes.length > 0 && bytes.length <= 32768); sha(process.env.C2_CASE14_POSTAPPROVAL_INPUT_SHA256);
    assert.equal(hash(bytes), process.env.C2_CASE14_POSTAPPROVAL_INPUT_SHA256);
    inputByteSha256 = hash(bytes);
    const input = validateInput(JSON.parse(bytes));
    const root = '/dev/shm/case14-postapproval-' + input.captureRunId;
    // One process attempt. A recovered/replayed task must never reuse a partial operation.
    for (const stage of STAGES) assert.equal(existsSync(root + '-' + stage.name + '.json'), false);
    writeFileSync(root + '-intent.json', JSON.stringify({ inputByteSha256: hash(bytes), captureRunId: input.captureRunId }) + '\n', { flag: 'wx', mode: 0o600 });
    const env = {};
    for (const name of ['PATH','TMPDIR','DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME','PGSSLMODE',
      'AWS_REGION_DEFAULT','MERI_SYNTHETIC_FIXTURE_NAMESPACE','RELEASE_SHA','GIT_SHA','MEMORY_CLIENT_REVIEW',
      'MEMORY_GOVERNANCE_LIFECYCLE','MEMORY_GOVERNANCE_ENFORCE','MEMORY_GOVERNANCE_CENTER','MEMORY_GOVERNANCE_TENANTS']) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    // Only the existing composer receives the four injected DB secret fields.
    const composeRemaining = input.approvalWindow.deadlineAtMs - Date.now();assert.ok(composeRemaining>1000);
    const composed = spawnSync(process.execPath, ['/app/apps/api/scripts/lib/pe-compose-database-url.js'], {
      env, encoding: 'utf8', stdio: ['ignore','pipe','ignore'], timeout: Math.min(30000,composeRemaining), maxBuffer: 65536 });
    assert.equal(composed.status, 0); assert.match(composed.stdout, /^postgresql:\/\//u);
    env.DATABASE_URL = composed.stdout.trim();
    const deadline = Math.min(Date.now() + 240000,input.approvalWindow.deadlineAtMs);
    const invoke = async (stage, body) => {
      const remaining = deadline - Date.now(); assert.ok(remaining > 1000);
      const path = root + '-' + stage.name + '.json';
      const child = spawnSync(process.execPath, ['/app/apps/api/scripts/' + stage.cli, stage.mode,
        '--input-env', stage.inputEnv, '--out', path], { env: { ...env, [stage.inputEnv]: JSON.stringify(body) },
        encoding: 'utf8', stdio: ['ignore','ignore','ignore'], timeout: Math.min(90000, remaining), maxBuffer: 262144 });
      let receiptBytes = null; try { receiptBytes = readFileSync(path); } catch {}
      return { status: child.status, bytes: receiptBytes };
    };
    // Root owns pre-launch approval/reservation provenance. This is a fixed native
    // read entry, not an attempt to transfer an in-process WeakMap through JSON.
    const helperBytes=Buffer.from(PROJECTION_MODULE_B64,'base64');assert.equal(hash(helperBytes),PROJECTION_SOURCE_SHA256);
    const {runNativeProjection}=await import('data:text/javascript;base64,'+PROJECTION_MODULE_B64);
    await sequence(input, invoke, emit, Date.now, runNativeProjection);
  } catch { await emit({ phase: 'FATAL', code: 'CASE14_POSTAPPROVAL_ADAPTER_FAILED', automaticRetryAllowed: false,
    effectStatus: 'RECONCILE_SAVED_PHASE_RECEIPTS_BEFORE_ANY_FURTHER_OPERATION', acceptanceAuthority: false }); process.exitCode = 1; }
}
// Run for a direct file or the outer's inline `node --input-type=module -e` body;
// importing the builder from another inline program must remain side-effect free.
if (process.argv[1] ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href : /\/\[eval\d+\]$/u.test(import.meta.url)) await main();
