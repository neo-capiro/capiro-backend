import { createHash } from 'node:crypto';

// Fixed metadata, never copied image contents. Import performs no filesystem,
// environment, network or process operation. Source proof is not serving proof.
export const NEWSLETTER_PINS = Object.freeze({
  sourceRepository: 'neo-capiro/capirov2',
  sourceCommit: 'af5f208961e6c9a01a6e489a7f5b1a6e6edfd736',
  legacyAssetTree: 'fb43d37e959d524a52000c054396cd13a54fbb4e',
  frontendRepository: 'neo-capiro/capiro-frontend',
  frontendHead: 'b945b799591c7a0345441a489b27cdadee202235',
  frontendCode: 'b0098f905e07a0e667566d7d7b0a8f7a8938423c',
  frontendManifestPath: 'docs/newsletter-port-20261012/asset-preservation/ASSET-BYTE-VERIFICATION.json',
  frontendManifestBlob: 'de1385b1f078f4307b381d0e6c925c15d6653eee',
  frontendManifestSha256: '169e5a0294676f031cdea71634e9481f64105286610d2f682da91c231af79324',
  // manifest-order path TAB publicPath TAB bytes TAB gitBlob TAB sha256 LF
  entriesTsvSha256: '8619b8b41de3d6e2001682a781260d1c90199dfd6dc3ac7e5a99b457fe27fa01',
});
export const HISTORICAL_NEWSLETTER_ORIGIN = 'https://app.capiro.ai';
const TABLE = `capitol.png|31192|cebcd54d90c9056ba5707fe502a09f4a329d3cb7|f354a71c6fce886271809b0c5c73c7e0ee6012d73558bc23b5f5375756565312
capitol.svg|1333|73f25d45b29f5b023e00788c9ba10569ddb8bb2e|65221548aa001bf52618eac9e4109e1cd644af431932457d0d59e8921e33e7a9
newsroom.png|55820|da62db86f5f0ccaf87d3e6a9b8745a40990b0a3e|169ade838cad34c618a6647adb4c6b6f07a5fb40bddd5ab111d53cf443ab8531
newsroom.svg|992|9ed7052c6f65bd6b5d603aa0ba5af47587d2db51|a38871eedf905dcf79932e9b59f5beb9b94743af9054915d84702bf9368189dd
policy-desk.png|27879|273d8477db1f72f613a9f53ef7339ac0f07b195a|05d2175fb65fc3307bf8ae6a7e851fae617029887b90ba81910fbb0c78b15556
policy-desk.svg|1089|e807f7e4ad7d82383dc1de1553a65381c8f31826|d1cd4dc690d7ae35954b28ea9f4d1a2a9e2e3d1b010737025da96673f7b674db
social-bluesky-color-white.png|2310|9cbc4d422c6276096b26cd28e7f5ebd9dbc4e3dd|0b3c385b4f08354f562f3b5bda38ae02f6872fb6252cc4e1fb16ff5985180e9c
social-bluesky-color.png|1650|cc20b3895777237ea87efbd7da18e50005dd1089|57ea6baf35376dbf032b50720ae35514f483f6ae93b7a374f13d31d2b93e86f4
social-bluesky-dark-white.png|2446|f796318cb061de2b182e5ca4591ce00f67fb5a65|86a6518fb25adfebf24583fb6434c760efc1283b0bb1ce44742ee54bc90d0667
social-bluesky-dark.png|1662|64c982b7b14ee6c1631a8b2c786dcc59908b5d17|bfbf1edd9f6fe91a314b265a5424906bddd7d34648a7e5a3ddc72e05d60f857c
social-bluesky-gray-black.png|2357|66af27d8a771d22e4ceb0d9a3ac3cb271f81eafb|203ffa95129c9f29487b84b06361ca697492bfebd4459bc6af5831edbfa9886f
social-bluesky-gray.png|1654|ec51088fa371653ab9d4422b8d01c23e1b634285|76425ad7fc9033efaf257403f9f4ec4ae1f05e976168b6144a4c0ea8d159d4f7
social-bluesky-light-black.png|2321|715fe711912105ae60cbaa2afd11252d17d4d444|d1dfedff3f6f3d8593495fdac0a001499d9bfc994c86de0249982c78e30b09af
social-bluesky-light.png|1447|d2b6dba355034e9088aaa1acb7bac3e52dcca61e|1f2b6591af5c8d287dd14cc96cd0f1e4f2524cc1d0c0ae63dc92914cc19dd92a
social-discord-color-white.png|2482|af6a62558fa7f0fa6d16e1ce2930212fda4f8f0c|89308182c2c88a3fd1071fe21daeb51e451b69452b76dc2b916505807108ce17
social-discord-color.png|1821|7981cefb48b95f70cdf855a067020c674c390efc|e520edcab7e85eff28476a342f6ee1eec0bc54ded5045142be8ec582968c1bca
social-discord-dark-white.png|2409|cd9dca13b875997fe07b2eef953bf326b7ed4659|a5265c9d8a43d808cadaad971740ead1782c5c2951aecda9a7bf2049f49dbd2b
social-discord-dark.png|1629|04dc76de0fb5689a4641499f6db1c71a09e2f9a7|639681083e279b079c287e39e37bde0023e25f3a7f3165f753cd612035d85a7b
social-discord-gray-black.png|2291|06f611382f891e3eb740bead666a49c585c25683|94b821a5ae06e7a802518054e376ac6abfca924b15c7dca32d58cb0945255a4d
social-discord-gray.png|1643|8139b9aa7e8e84924da62e114f0eb43fe3e4d012|85a1018cb0056569143f7c0603c1473264209a7d4ca883ddd129bcd36920a368
social-discord-light-black.png|2269|e2fedb9661b3bdba0b5bb11dd8d1fc4b46aaf769|5f1c0fa5d40ed182f43b289a34bdd95f2286c1083bfe479756b2fda02c93063d
social-discord-light.png|1456|c3aa7bb2ecd91e90895ac361ef13d3b4208a6b0f|7d273df8dce52a3ddab7ffd3addbb8820541fa688f0ab2d39f9142a538db7ef5
social-email-color-white.png|2138|ed57ec26aad0f7a43608aa13bc382e57dcb0ac91|f3f485f210e365dc3bd61af79eb6c1a821c66669497aa1dc6155d5cee70b3fed
social-email-color.png|1308|6991128b52d76cd98ba58946318bd35d25c60f07|129499f19fcf77754570e6a5fb24f7bc19437f5d4de37fca61a4dc2a5133ee30
social-email-dark-white.png|1983|f71e59800706159ed2cd517be1159d212f83d7f5|4d4b7385e60e04cebb4841dfb1b13b7fb8481f0ca8a299c6fad567c92fa7bce3
social-email-dark.png|1160|dbb5b09344151e2d1adcb12b61f89ca48061533b|c87d68267772106228730761e35f0fd29748c1f6a5a5037e79896992d92e2a55
social-email-gray-black.png|1948|3a9227c6ab2891ee4beaa4067923b6e0c9b7a99a|103b83fe42945603c2c1746a105b3159f7d51074e6cc402981fb020bd4c80a4e
social-email-gray.png|1172|298b27f897064d5043273b655fcd6c621485cd42|3e0f768fe342cf452d2613592142ed948d549a7e7632bb2e72c3ba93d60cc002
social-email-light-black.png|1817|7bd30c937fbd453257cda0bddf9290af6b127436|6dae9248027e8144a17c93b5462b5be54985094ab7dde5e062a44ccde2668a17
social-email-light.png|1019|38c8409358124c31ff18a786c3358d83f8325ce4|e5c4ac1468785680e45d5fa3d6543f85f533bd6ea9729c7e2b7784eef2fc0293
social-facebook-color-white.png|1867|c9e525fd896f34b0e89676dfc237573d0b794eca|67d9a8abfb21af6e7a446be59553ac118ae1253f0ba157c669cba2e17dce8282
social-facebook-color.png|790|5ff3a0127caf7d665b05a9169ec1d18bb1d3a94b|6663e43fa3f23efa7152cfa793d4282a0ac753e622b0ccea2cfe12725dea45d7
social-facebook-dark-white.png|1717|40adb6bbbaad3d1bba1ae7a20789c28efc6ebc32|381250bbe91c193a66fc455126018444ce43d53b0fdc4bfbbfbbea038c2a2735
social-facebook-dark.png|715|31923f446c181e2c18d6f0b2a198630bd247f6d3|b2b692659f3cad58a8065b38d43144ab7c4fbb6ead5a077c48631afdd56d7782
social-facebook-gray-black.png|1706|e05b135af11a2b88af0137d1fd4d211d12e95050|e0235b9f6d9b9359c9db866f44bb6fd088010a164d7110ddbb7b950f7526aabe
social-facebook-gray.png|731|34368c9850677871af94fc8ac2534776cdb276f4|a915c51ce0e63b14750736ec079a1080a827019aba960bcd77a72460b1a253ed
social-facebook-light-black.png|1556|da0dd14ba4fdfba6f9216ae1b46a7d4a74bcc5a6|c6a3d59cbcaeaf779d0819333afea1241244fcb52662d16137158b7053abdce3
social-facebook-light.png|625|c4e162a205dd82cae6d36579264787b6a0f5b49c|dc08d9cff42fde4e541e9030ba0fed335d6c3d11e449910dfd85d72c6f8e4935
social-forward-color-white.png|2138|ed57ec26aad0f7a43608aa13bc382e57dcb0ac91|f3f485f210e365dc3bd61af79eb6c1a821c66669497aa1dc6155d5cee70b3fed
social-forward-color.png|1308|6991128b52d76cd98ba58946318bd35d25c60f07|129499f19fcf77754570e6a5fb24f7bc19437f5d4de37fca61a4dc2a5133ee30
social-forward-dark-white.png|1983|f71e59800706159ed2cd517be1159d212f83d7f5|4d4b7385e60e04cebb4841dfb1b13b7fb8481f0ca8a299c6fad567c92fa7bce3
social-forward-dark.png|1160|dbb5b09344151e2d1adcb12b61f89ca48061533b|c87d68267772106228730761e35f0fd29748c1f6a5a5037e79896992d92e2a55
social-forward-gray-black.png|1948|3a9227c6ab2891ee4beaa4067923b6e0c9b7a99a|103b83fe42945603c2c1746a105b3159f7d51074e6cc402981fb020bd4c80a4e
social-forward-gray.png|1172|298b27f897064d5043273b655fcd6c621485cd42|3e0f768fe342cf452d2613592142ed948d549a7e7632bb2e72c3ba93d60cc002
social-forward-light-black.png|1817|7bd30c937fbd453257cda0bddf9290af6b127436|6dae9248027e8144a17c93b5462b5be54985094ab7dde5e062a44ccde2668a17
social-forward-light.png|1019|38c8409358124c31ff18a786c3358d83f8325ce4|e5c4ac1468785680e45d5fa3d6543f85f533bd6ea9729c7e2b7784eef2fc0293
social-icons-attribution.txt|508|5de712e2355b9246c070f14c345068920f0ca18e|3aadf1580c4a90dfac6895616a13241759ad253615091782edcd07b444f924a0
social-icons-license.txt|7427|69403b25cdc6beb4fa65d13858e9e7aee7e2c672|20c6f40715a567c97b80f6944beb8bb325835cab47ea7dcab89ee3b8e077eced
social-instagram-color-white.png|2890|95be9e0978c5ceb588db83cd302887f1594b902c|6b4e3b573b57848ea163ae403a62ebeb5bf01367d10997ff593beae9de38a4ef
social-instagram-color.png|2376|a84a17b7c62d926ce78523e4e741468c9fa7cf61|90dae07d0fdea7d5c1d5cd4b778978be8103f84827ea18b597734a59561f13fc
social-instagram-dark-white.png|2785|dd3c9a35d6ac31b2a4f71343172995c353fe40e7|fb9bc16551337004984abc9236c31cda5e6e94f868a911f666a8d68bd9450568
social-instagram-dark.png|2113|4d18bf8278247a0a66b5b900422ce83caea37b2e|4855c6de2962e3a101d293af1abded13491bd96ceb9f234d6293028e88e9faa5
social-instagram-gray-black.png|2566|1d2bf9ec5c7610fb352ccd3ace5a29c5f94554ca|595de397df837eca6f2c14955c63d205fdb34a0fac33a6b07454da9051d311fd
social-instagram-gray.png|2128|a688a7bb1f665312fdba9fdb42f998cc04e7901f|84ec1f1bc9fd7b93f9dd1a4343471b374071b517e188c9cfa0681b7819d1c084
social-instagram-light-black.png|2646|c1cade8a65816145d1d1ebe0fab6fb0e595a3b00|01d4a8feefd19c1f1f8dd11c2cb88e9bc2a645c5eaeb5bc94b2a20f73d082d28
social-instagram-light.png|1886|9ae122f36ab1db0c3e18a2e2f321acdb986ee2db|879a9b410dfd0a3e15c51d839295025cec90c44c70573f8ef5f83662bc887ecf
social-instapaper-color-white.png|1411|a8b383500a120fca1c3468be1fdbfe632fd0b457|cbe7a103b05095eaf9355f7078b67c75dfa83aef91b57baab97cfd115a2a645c
social-instapaper-color.png|315|cab56ae3e7490fb79f9efb2f3866a2fcce014d37|d6d0d6f3e773667754e5eea4bef60fcdcdee20eff8482d45d63a394898876116
social-instapaper-dark-white.png|1411|a8b383500a120fca1c3468be1fdbfe632fd0b457|cbe7a103b05095eaf9355f7078b67c75dfa83aef91b57baab97cfd115a2a645c
social-instapaper-dark.png|315|cab56ae3e7490fb79f9efb2f3866a2fcce014d37|d6d0d6f3e773667754e5eea4bef60fcdcdee20eff8482d45d63a394898876116
social-instapaper-gray-black.png|1425|554a9223adf28ce61dbec035671fce04df5caeba|b203e0b47e8921ad9125bbac2ece6efc1f3294ee1d4478bfd8e802058a1d4306
social-instapaper-gray.png|315|175e1cc0b5bfffa3a6d5dd2e666eb3d5302ddc6f|3e9d5a4fa581f7cad89a2529ef773eada5b83cf3e60a060e972da4f6c67f9f57
social-instapaper-light-black.png|1247|b04d633306b50587de75f9d32cad3b5107787a2b|627cf0469dae946737183e43876292b45cbb04e1746adedfd891722c1db2aecd
social-instapaper-light.png|289|f43badc71f31c70906e915805b253581f79d1123|a693bdb89c13930c8987578871b7e999e8ff2fda7bff6e4761fabe539bb74e79
social-linkedin-color-white.png|2053|6643bdc158e1fecdd8bb91772e56e5a9e12b52c3|bc6a22e4e0ec5c8bfbc36b5350c571331930e9c560c7f349185a5de64c34af5a
social-linkedin-color.png|963|54c8eb14888fee6461ab7db53d463bcec1552729|22b3688ae09f67ebde18d5704f0ec2c280fd66b30e3ade93663f563feb0176d3
social-linkedin-dark-white.png|1897|8d215b8d116ca477cd5a954683686b96ec7efa76|a00056e733d43d567df49d92d9cf390d988f6f29099e8e03c1ee52bd6bc964cb
social-linkedin-dark.png|854|fc0421a7ca73d640d0abb0d42d1d19fbb6f3eb7e|65c9ea02b894763b15403f854a5465ceb40184ff519b90d086b8d0b11195ed99
social-linkedin-gray-black.png|1877|cbd2e7e08e20e2f28fdad125919fd392eaf11642|7b5e16d9d1cb223727a6307973054c7fa7cbae1fce6fb3f8cb5c73ec56f48fa6
social-linkedin-gray.png|861|b2634462f50cc3fbec0cc38e2b1597f61a0ce9eb|90e23ed7ea81bc7ec815cf4ce879d2de4352bd217dec3d10d64292f3b0370c9d
social-linkedin-light-black.png|1749|855fb90c46c050695e1c0e8276607a61aa263564|c1d74753b0e8e601b0204f017e1caae1643ded51bf28761ea5ce63580fc64af4
social-linkedin-light.png|747|abe14a2a68224d791fc44677ce0b9ec6123bb444|41695e34c6ef8ca47ad2346cb1570a978d685513120899ba49d508305f00f5aa
social-patreon-color-white.png|2075|7a17c4242cb56ed696285b88a2b4860f70fdaa8d|1d0ead9a6caf784c669fea3f39c37b492d1a1d33b1f1412b2a09007a166f9d3c
social-patreon-color.png|1197|0f8c12883648f27cd54ea510b53f8e8065d9f522|2867ee10d25439468a0cca99a6c17bd97f55cfc72f542b34c155f71e52823a92
social-patreon-dark-white.png|2075|7a17c4242cb56ed696285b88a2b4860f70fdaa8d|1d0ead9a6caf784c669fea3f39c37b492d1a1d33b1f1412b2a09007a166f9d3c
social-patreon-dark.png|1197|0f8c12883648f27cd54ea510b53f8e8065d9f522|2867ee10d25439468a0cca99a6c17bd97f55cfc72f542b34c155f71e52823a92
social-patreon-gray-black.png|2051|71bcf6849d69cb6f1d66722bf1007ca61341e4f8|6a858ab503828e066f991193a93481268548c2a77e4fbb91d0e73a2300ac4598
social-patreon-gray.png|1219|3f091427d0820642c2821b379fa5d06392bc5b89|e70ab6a706e93accb4e48d8f07b5d2f829199474d650611eacccc69749343937
social-patreon-light-black.png|1938|c0372b540bcac4c6687c1a981ca8d1aea644e058|19978bf302dfb5af8ff2d265b624f289b14c15730b4533b78ebe2d3a95386e79
social-patreon-light.png|1055|9880af1d70fd430c1a615b7c6de807525f832a77|a3332592c641c17b65ecda9aa22824f1e8ec93eb22b31ccc1433298b63acec21
social-pinterest-color-white.png|2700|170dd56cb818fe3a8e026ddcde4d9e407d4fed65|09c83407f18ef32e5fad185f4ddc2ecbbb25cf5dbb8e872963b026c44bd55b11
social-pinterest-color.png|1923|68b0d004d39e901ccd854aea73f6391297e90d31|d332b9eb060dbda2fbfc3425d79e6ab03ca437cfdb646977c3ac15ea75d07e49
social-pinterest-dark-white.png|2601|1242eb6a993da7ff65926aa776a868531de079df|29076f169ca1822edf14e8adf1f187c32df3fd254ad5020dda57e92c978dc9fd
social-pinterest-dark.png|1813|94c28b4c755a46f1bfd097c8f295da63fc901d38|5b9189168c0142122a31fe9f47bac9d0e6289d7e86c4be7155b1f483d48d7bc0
social-pinterest-gray-black.png|2446|4b9fb8782efe1e44813daa89ea9eb790b411c6bd|c92728fa6a4642748fe69c0d1a6d0e05068489b4d81f01c68e9ed7c25bfbcd50
social-pinterest-gray.png|1826|55fe6e840da3973955b130c40bd494174e57f9fb|1db3c76a12fa9c126b13ad0bafa7fa03f728dee316dc9022d25ab56ada0efd4d
social-pinterest-light-black.png|2458|89521f62741b5090eb0b84835ed3d5ed53160b21|0a4b385853c343b6089267e3d199d9a03ee02faaffb4a013a81993010b7cbaf3
social-pinterest-light.png|1625|7d0059831637829f97813f52e720e03e2da12662|610a19bc386a34d04b851d061add3fcf3b6d0f8a682b0fde4841db46f529956b
social-reddit-color-white.png|2396|d8051bae90bc948c214abcde73f79dab88a54bf5|8ebb780420ca7715ec77e6dc0609a1a484d927f00d1cb1d33da91e9b7826cee1
social-reddit-color.png|1791|a379ba8caefc53a2acad8e6ae038c56c6d0d4e8e|bb07a5506a9b40e9864413ad2717a3593004fc0120ed1bd74723df0ab9bd1e31
social-reddit-dark-white.png|2525|4f5258174f6ce5fa48650bd8f89fb101af978785|d282b968b603233c5efcaa372ef764c177647e40b8cf8a41b4f859c962b474c5
social-reddit-dark.png|1806|ee5f252e979e88600ddd5720ccebb043235b5cf1|1bcd68d60a4c3cbb59e93e21320a790c530c284e27100f9eaca47c6d23efcda5
social-reddit-gray-black.png|2391|40b2a7acd5a2a9d381b845321fac09242f2fae86|b34c380e12cd9bc2f929a724c27e4f81d0916893d833ab7f6b5be8e5e0a8dcf2
social-reddit-gray.png|1812|24014097f1a8cf1158c336bf8db6ca98ced913b2|c73f5c8e8da0b23d8536c9f82149939397ef5c29dadbe8e484c186660a2349f1
social-reddit-light-black.png|2371|c77523c176806955177b3ae9077512454224908a|38749ea14339cb782ec95662e07c7525cec8a828242fd0e3e842c2a92dc20d66
social-reddit-light.png|1614|76390638f171bae229f18f1e42b935fe8a937353|9a7aaa38579d9b1c3db920349143af7de2c7651d8cfd6e2e47f83169d4b2b812
social-snapchat-color-white.png|2761|e923ac212a2d98738bd2b0c5fd40769f9e1d4f83|4c3e03644f4362512307b10b1fdbfe676e5b9c67d63967187d03765afaea9cae
social-snapchat-color.png|2127|784d664dc36f567497a3a5a00f09638030ebbe1c|6dd67be1b3b71fba5f961e3902ced9ff84b77edf6cd4a2636a718898dcb7da40
social-snapchat-dark-white.png|2756|dc0c7b14206fa0cc350e73ae45aa5da932298fde|4fcd3770e1b4b9140e49571bbfb168e40f1da9d2d7de1a62c3456583a4aeaac1
social-snapchat-dark.png|2024|b4397cf99b226a33851461d941db806def8604d6|419ac155675fdb991444a492242104d4991bd5b3cdcfd78aceae6167b42ce206
social-snapchat-gray-black.png|2568|2fd06145e4baf3c79213727a09f295c4a8d8452b|e8657e854432e6035b9148636ad853384f9cfb01d634698ab3827e1b6a08babd
social-snapchat-gray.png|2031|f43a287bbea3dbf962f7ec95a689bcf993bdc1d1|efc444fee08156bbbb01ebe0c7d9cad3ab7462086dc562e131911bcae86fe82c
social-snapchat-light-black.png|2606|bdd052467bc68623b192e035af04918df96c2879|6e71bb3d70fd141456ed210b05bd21d82bb107d15a81ba007eb06c3cc068542f
social-snapchat-light.png|1773|52ec30411dc7ef1713429c322c00ea488f04e4f0|fb4c46fc46330efd3e6a6b958a1b4ce84911e78e659d2c88a535388b2d065f4c
social-spotify-color-white.png|2858|e84288d8974f947adcc6cba37d5150114e7caec9|0a14961f567bb7e467a9f559e1bbad512818459eb0325b862f13c773215afb3d
social-spotify-color.png|2312|26388b755a570f473dca3f2649a97d56fa571608|faf6fc4c2befe5f381bbbddcbb62b5cadb320f3f7ac862acba7809e6c130e786
social-spotify-dark-white.png|2701|07c5522a87a8c59db464030d3a59e5cc922c2dc4|9b34ce740aa681e1034917352830a34e53b0e94244415756cc09cf85d51bbcd9
social-spotify-dark.png|2054|2fc549bffe8d5dc6eacfd2485770cfabbef90331|1cd04c75ec6dd796c2e0981505f92b5a0b3349201d8ddd33489a7192df12ac23
social-spotify-gray-black.png|2549|8d70335261ae2815a3ff8948ae90fcb662b28c23|fecd7eba0eaecaf5ce943e7e2162a93f670ff4abaaa54eb48a9a93235b4cc5e8
social-spotify-gray.png|2048|646874280aa1c62a9d8ee816a6f2c530a562115d|023b7a412119e973162ac0466e8c5cd16ab97d6be35ddab451dba6e1e110ef06
social-spotify-light-black.png|2580|f57ba4c02093285a54b7db8b041aea684e01110f|73f495e7d2c6b27783eed95102245dcf562307513ff2d236aea0fe9b63711176
social-spotify-light.png|1819|099916ec53ba114fc3e3f8603bf41e65040d0971|321c78f5663a946573db55449de497adfb86843b59e2841e2020a8f611007997
social-telegram-color-white.png|2505|20fe3a1edd177de7c0e9549af718bc2d46f67caf|8188660492814077392a66e8ce94f32fd0ad6b13acad9c655e839a69229e33ee
social-telegram-color.png|1918|60a5da33a9f8be118bebe980de7b37ce3dbe530f|0672d630debab71a45918790cd16ea39918c10682d794663e29f2feccd525cc1
social-telegram-dark-white.png|2428|c77dc53103ec57a5f6bdb55927f4be8eeeb7cb63|779bf0a3d24b2e41e7d7396fce98c819f739041fa68472307f3eee1fdc7d8bbe
social-telegram-dark.png|1727|e7001bd975dd41d768b370b51df817ae87d0929c|361d75b65a3e29ef05b26690b2354d2ab6c0042175a43967893c6a93dc38618d
social-telegram-gray-black.png|2325|9632bbbf8fb021ec736e994c858f25412ac197e0|7cfd91ad58ec2c44a10240d126a3c054cd6a58116812f491bf432977ac27827b
social-telegram-gray.png|1728|2071c233002b1bf30bc19d423b5dc5560b0d5609|5db15741d51610d6371527f95aa073c716c6c07a5d89c343b5043778b1f68f41
social-telegram-light-black.png|2305|e18fed3d04f681773a89e0898f7eb73baac1cf70|ea6d9aef5608dbf03881e16b6bfe706995c2193217318d83b539b76783be0cf7
social-telegram-light.png|1529|30fbb9fcca8bd1ef16f1286ff39fc183be919160|7b516a39e95f1c742abc01bd2146ecede9aae62d4a23d7c3ada76b1a56cbe9b5
social-threads-color-white.png|2906|5849993b59c485880c4e99138b429d848442ff39|52f61238831c578b315ba29cd80c82968ef45264226fda2fb4f1956b175bdf89
social-threads-color.png|2254|cc595c85eeb3c8018f69b24149a72629d9f4fe4d|1a7f413b1eb6b0b2fc1f61c3f029967dd5362f958ee7e1dff7462a3778ca712a
social-threads-dark-white.png|2906|5849993b59c485880c4e99138b429d848442ff39|52f61238831c578b315ba29cd80c82968ef45264226fda2fb4f1956b175bdf89
social-threads-dark.png|2254|cc595c85eeb3c8018f69b24149a72629d9f4fe4d|1a7f413b1eb6b0b2fc1f61c3f029967dd5362f958ee7e1dff7462a3778ca712a
social-threads-gray-black.png|2733|51e372f5215360575f1e4025b57fdcf9764d765a|5cba0b1abee34a73dcf931f2c7bcd207b99eac5ea394e76654cdd222bf045b2b
social-threads-gray.png|2253|c317b5f17a2573ee4e2d035a4b7b09c066503c1f|3b8f2f24cc39bcecef7f2ce688846e970c95983ddccdee69e3584568d5fdef7f
social-threads-light-black.png|2775|0caffebbe466c839836a1e9b38c8a924501a3383|0901e05135bc72682e3f02e4dfcdacc4aef078689fa342a9a1a20129e5724262
social-threads-light.png|2013|7aabb2579ca7e2faffbf8187e35ab49544ab2fd6|4038d5e1898506d856ec1bbb7b2e3d7ad73647039dc66c57563db67f33fe6d0f
social-tiktok-color-white.png|2141|c8b1fdc8943966cbba08b437aa819bde2ef7e7f4|635b18d8be4700147ba9ef750c71ae038f2acc5ac2a2eeaef99abba5e993b08a
social-tiktok-color.png|1276|9900ee3f6368d4696e6ca3b241635bb46ff59e63|f11f5655e22ba636c967173bdad3e35f1cef9fa2f90699e12739dc2737c73c14
social-tiktok-dark-white.png|2141|c8b1fdc8943966cbba08b437aa819bde2ef7e7f4|635b18d8be4700147ba9ef750c71ae038f2acc5ac2a2eeaef99abba5e993b08a
social-tiktok-dark.png|1276|9900ee3f6368d4696e6ca3b241635bb46ff59e63|f11f5655e22ba636c967173bdad3e35f1cef9fa2f90699e12739dc2737c73c14
social-tiktok-gray-black.png|2072|fb1775b3e65686f4c690dee63f696e044856c11d|1bff7d2710e9cb57ef398b51cc9534a026dce4b2a85b45af9bad25471540ba6f
social-tiktok-gray.png|1295|0e433bcb0faaaf89abc207acb6df15f1643cc51e|b790a48b9d78cdea4b7d2bf509654d807bdd798ac5f346854f423f839545317d
social-tiktok-light-black.png|1974|c947b846cc7b0fca5ad863c0812e5a4dee0148f1|6ec67c4bb8cc4aed5566386c1044ce47532092f8e40f0ab0671a8e9ef637d11e
social-tiktok-light.png|1151|0ee89d7f04cc0afeb3389f5b5543dd84f820bc7a|081fc38b655739c30376a3b061a2e889065e28d59ae42801261c0cb1df43f45c
social-twitch-color-white.png|1989|4d2ee18bfc729d772283b8ec0513dde9392ba63a|3fcbeb94f93f6dd9ee56e0d780d002ae862e6bd3e1fe089a75513d74430f748b
social-twitch-color.png|1086|6f01526138a186f6de963e8440482fb9b4df83c9|c3fcc913d05a197adda61cfd9087a176b786ee7e6d39c369d25ca8a9c6b8b2fc
social-twitch-dark-white.png|1984|87e8b562110b49a24525827f869864f20397a235|73490bf0008bb4e39f513aed7e278457880b1b0c7235e858317a87df30283f3c
social-twitch-dark.png|1023|32fd5ee41604c392ae34e69178b0b8c0dbc8e9c3|3e7c9efe6125e8cd4a4e68178e52f548bb490109f269d8916ea0dc3093d3aab4
social-twitch-gray-black.png|1942|01da933cc5c5ed2a8c8f2b3dd4a35063f6a70fce|a0d10b9c6d0b4cbbe263df299934863ef79e50594d3c5085215e6ec827e3703c
social-twitch-gray.png|1033|2f9f0cf41b6208f9ffa7c3e660c2018bb199d132|af2ecaabe264d33839e2f5cb2e9e2e827b0c75b17a41092fe5b8c269e761f3ec
social-twitch-light-black.png|1790|1dbf856feea35de9b6fffd70cdf23b8eb2ba48ab|b6386bcb4bca3338191ea4ccfc6578b621c3ec19deac616dc38902d98958e010
social-twitch-light.png|917|5509d42abf1eb5dbde2f736d6003dc08640b7536|844b9b9dbb58a426f457bfc2e112e3c37173f3c2e51e783f44573a5e810ede7b
social-twitter-color-white.png|2527|32796fd2eca68c7b83aad6695202626a30925fb7|8cf9471dabc3e27b79924ede2d4757d89644baa4eb73ed3f7369dfb3c366b4b6
social-twitter-color.png|1566|5a74d3b8f5787a5176521600d38023ea59fff97c|c5af90126682de59e86bbcd20f19202656f33af7d65436b73e2f3b9375e2e57d
social-twitter-dark-white.png|2527|32796fd2eca68c7b83aad6695202626a30925fb7|8cf9471dabc3e27b79924ede2d4757d89644baa4eb73ed3f7369dfb3c366b4b6
social-twitter-dark.png|1566|5a74d3b8f5787a5176521600d38023ea59fff97c|c5af90126682de59e86bbcd20f19202656f33af7d65436b73e2f3b9375e2e57d
social-twitter-gray-black.png|2350|94326c611da3185959c9fe7413e9e6fc6c09cae9|58e6c576494f4f3345bb2bdc565c1434eb015eaeac7afbc427266d0671078cbe
social-twitter-gray.png|1598|44f9f5e4827e56fd618c673c9c135752d8fc7be4|f9596ef2e94b26695d47a3476550f9337d6643d18cb0a6bd769647a13e5dd405
social-twitter-light-black.png|2381|55343c6c0c18c1abe254d22d5c95152dd7df4d5c|169bcb508869e16479d1dd10937cb3b1e04f369245ce2a2d9ef97d56458163b3
social-twitter-light.png|1382|b0e7af6d059ea285e9430a3f09820c5bd2ce5e65|d19ef5a522cb75e1f93daf1affe24461e95d6b1aaef093704411b1ffa077915e
social-update.png|40618|115a6a7ec2f212161b2e5f609abc408fe970c7a1|6d60daba33551a9011e94329ba6cb7f11de119e9273bd386a8719d03e3b616f0
social-update.svg|890|1a1aeee066b358ff9dbf4381563a72bfe77aaf88|cb903be6b9a58d8beffd148b911805619ce3b99f9ca30c1895e76bfd412702ec
social-website-color-white.png|3008|8a86b3cb67b41c1c9c13af1bfb1523159f5016fd|5eb25284801c33ab0a7206ece87c9a82a12ea649a939b5f36608bdfaa456d363
social-website-color.png|2221|d0a68b40ac2d7cf62f2c6df29aa5d8ca126b0248|b02e1d565a3356075c325eed876fd53fe3e303efe4f4b4b16f043fb589406579
social-website-dark-white.png|2855|b31d50a5685e4391c903503f069287d8dc9a7ba3|a00719634fbc3100faa492a0b262ec8190c9c55d60f687f49d6498faae9cacf5
social-website-dark.png|1947|80ea079ac7f4eb93037f8bd72e88d2ac5b794af9|a8e5fe6990557c8f7992ddaa01235b2d7c26cb1860440bd80c7a67d1806737a0
social-website-gray-black.png|2582|874d42386d59024ce6af2b050333298fa1b075b1|fdaca027657315c4c7922b51400a91a52bdbc6acbba6e824165e3e670d7b3efd
social-website-gray.png|1977|688b249ccb583b4981309431696e05c56889de14|8db22bf3683e8c900b3d4757c45f3a552981643ecf07a7c2fae180f6adb81b37
social-website-light-black.png|2725|e9b15ae28b2ec5d949f52491f37a6cd53dd1a861|7fa75984c010b0db34b2aeacee79d074a77b6020f1d620f8781b5fcaf3d06868
social-website-light.png|1738|30182eac564620b0249e4eb7c1a66c6b9ded79ab|29a36e11fada8a0cc25173eb80d635725107f65cd27807611371cc742d769a55
social-whatsapp-color-white.png|2973|c6d33bee2abb9bc734bbbdca536dfde03cd337e9|c0d3ed1110d5927cbe7fc5490b092b93f18078d8325045a2f31fc1d60f0663d6
social-whatsapp-color.png|2367|f35247ff0d7b7cd4faaa816f8ddacf9cfb2f10d9|69cc25e5b3f22e7b6e70f576729ba01cdcb505a6d9346f1f6a39aee5ecc17cf1
social-whatsapp-dark-white.png|2858|6a4413a1ea159c7f1519e0507b6de56f881ef367|283768ab2cad7c26a9d8a447fc9ec40b2ce7e971a94321c012aa7e4b7b0a8d8f
social-whatsapp-dark.png|2138|bbfd8957b1e42ba351c2774d81700a9847174e22|f0e518ada18fe673c6ea281cf148aea13c0291c2bab796a5fbb0923bd076776e
social-whatsapp-gray-black.png|2664|13a1ae21a0c147138c872cc951c8a326308671b1|955d3c09b6bcdd1d7ff5d2d26516b8e1219a65195ce0f76d6df4a62f38deb2d8
social-whatsapp-gray.png|2146|64b1d27675e2b2b2580b567892ac9ddb14ff3625|c5284c7baeb9d296b63d1f9c3a4a0acea71242283e81152a3c38f718474e33c9
social-whatsapp-light-black.png|2708|c464af610c21896099f0a8cc55020f517fc80f60|196883d58b0c63f339b957f4a97099d855f3b59fad8c1d1a6b43f94f9a4cfa44
social-whatsapp-light.png|1897|96c91a91a854357686d14ebc920c2c57ef4a72d1|e78dd49e46b3703ee9c9a8b1c553142b9089c02f0204c733203d19455009354c
social-youtube-color-white.png|1757|6b19db2a732a6eacadf4f75438db5fca33b53f8d|2cb48501e44360174080667cb6b00b6c384f482f6d72fd128db8d7fc89ee4e19
social-youtube-color.png|1005|fd4ce005d8de35ef0a966186b714d1594691ba3f|744dd35066821a0b93021453deef00f11a5c4dccb1b0bfc3fa4e15640dac93fe
social-youtube-dark-white.png|1987|7919a71b8dc79ead2526505d8e0d35c767c34baf|127f85e20ce0d08b921c8a23170a224b5bf8efcd96db86b0aa731b69e6b9ebf9
social-youtube-dark.png|1152|1d041314fb3de2118d83c11044e1706936f5cd5b|01bc77686cd48999b53e418d37e5a07d01d1831d0cd5e5347caef84cd071b8f7
social-youtube-gray-black.png|1915|2386f1e1b4a111da0b3a682562721503eff7257e|b080ce553ec883e7a4e8ac139155875f0069781e1fdba9a228ddf72fc0186c62
social-youtube-gray.png|1151|5618d902d7942f1661dd0a45ccfbcebf79197507|767feb2c16bd877e9dd92d735cd996fffec657fdbfd64198c5cee759759cd7b6
social-youtube-light-black.png|1831|5feaa1d611705c4cc8cf2546baf3dc1295859948|aa140b6595e6ad2db58263675f4e7983f608f504c53c775009cd91942229c804
social-youtube-light.png|998|1e309556052514a0fa0ef38c231242f8d222119f|3f84d9aea44d27b323d6b2b26529e3cd03fdd8b9ae7506065876e92b3fe4057f
template-preview.svg|1885|fc807f6848353ead90d50d957956d403d8e1f33f|90a97966db5b54dec83b99ec89da208245669b2a3a0cc1af248a14e9388dd1cd`;
const fail = (message) => { throw new Error(`Newsletter release refused: ${message}`); };
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const entries = Object.freeze(TABLE.split('\n').map((row) => {
  const [name, length, gitBlob, sha256] = row.split('|');
  return Object.freeze({ path: `apps/web/public/newsletter/${name}`,
    publicPath: `/newsletter/${name}`, bytes: Number(length), gitBlob, sha256 });
}));
const byUrl = new Map(entries.map((entry) => [entry.publicPath, entry]));
const tsv = entries.map((e) => `${e.path}\t${e.publicPath}\t${e.bytes}\t${e.gitBlob}\t${e.sha256}\n`).join('');
if (hash('sha256', tsv) !== NEWSLETTER_PINS.entriesTsvSha256 || entries.length !== 179 ||
    entries.reduce((sum, entry) => sum + entry.bytes, 0) !== 486014) fail('fixed metadata identity');

export function canonicalNewsletterManifest() { return entries.map((entry) => ({ ...entry })); }
export function newsletterByteIdentity(bytes) {
  if (!Buffer.isBuffer(bytes)) fail('artifact content must be a Buffer');
  return { bytes: bytes.length, sha256: hash('sha256', bytes),
    gitBlob: hash('sha1', Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])) };
}
function sameIdentity(actual, expected, requireBlob = true) {
  return actual && actual.bytes === expected.bytes && actual.sha256 === expected.sha256 &&
    (!requireBlob || actual.gitBlob === expected.gitBlob);
}
export function validateNewsletterManifest(manifest) {
  if (!Array.isArray(manifest)) fail('manifest entries required');
  const seen = new Set();
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !==
        'bytes,gitBlob,path,publicPath,sha256') fail('malformed manifest entry');
    const expected = byUrl.get(entry.publicPath);
    if (!expected || entry.path !== expected.path) fail('unlisted or noncanonical path');
    if (seen.has(entry.publicPath)) fail('duplicate manifest path');
    seen.add(entry.publicPath);
    if (!sameIdentity(entry, expected)) fail(`manifest identity: ${entry.publicPath}`);
  }
  if (seen.size !== entries.length) fail('missing manifest paths');
  return Object.freeze({ sourceOnly: true, manifestIdentityVerified: true, staticPaths: 179,
    renderedPngPaths: 172, svgPaths: 5, textPaths: 2, bytes: 486014,
    actualArtifactBytesVerified: false, deployedServingVerified: false });
}
function sourcePin(source) {
  if (!source || typeof source.commit !== 'string' || typeof source.repository !== 'string' ||
      source.commit.length !== 40 || source.commit !== source.commit.trim() ||
      source.repository !== source.repository.trim() || /[\u0000-\u0020\u007f]/.test(source.repository) ||
      !/^[a-f0-9]{40}$/.test(source.commit) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository)) fail('explicit artifact source pin');
  return Object.freeze({ repository: source.repository, commit: source.commit });
}
/** A custom identity port is a synthetic qualification model, never a byte proof.
 * readAsset is caller-owned: it must itself constrain filesystem/symlink reads.
 * An enumerated Map proves exact membership; a read port proves listed bytes only.
 */
export async function qualifyNewsletterArtifact({ manifest, assets, readAsset, artifactSource,
  identity = newsletterByteIdentity }) {
  const receipt = validateNewsletterManifest(manifest);
  const source = sourcePin(artifactSource);
  if (assets !== undefined && (!(assets instanceof Map) || readAsset !== undefined)) fail('one artifact input required');
  if (assets === undefined && typeof readAsset !== 'function') fail('artifact bytes or read port required');
  if (assets) {
    for (const path of assets.keys()) if (!byUrl.has(path)) fail(`unlisted artifact path: ${path}`);
    if (assets.size !== entries.length) fail('missing artifact paths');
  }
  for (const entry of entries) {
    const bytes = assets ? assets.get(entry.publicPath) : await readAsset(entry.publicPath);
    if (!Buffer.isBuffer(bytes) || !sameIdentity(await identity(bytes, entry.publicPath), entry))
      fail(`artifact byte identity: ${entry.publicPath}`);
  }
  return Object.freeze({ ...receipt, artifactSource: source,
    actualArtifactBytesVerified: identity === newsletterByteIdentity,
    exactArtifactMembershipVerified: assets instanceof Map, deployedServingVerified: false });
}

// Controller-owned contracts, not guessed static-cache defaults. Static Nginx
// has global nosniff but no explicit /newsletter immutable-cache rule.
export const NEWSLETTER_UPLOAD_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=31536000, immutable',
  'content-security-policy': "default-src 'none'",
});
export const NEWSLETTER_CAPABILITY_HEADERS = Object.freeze({
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https: http:; form-action 'self'; frame-ancestors 'none'",
});
const uploads = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'font/ttf', 'font/otf', 'font/woff', 'font/woff2']);
// These are unconditional bootstrap admissions. WEB_ORIGIN additions require
// separate configuration evidence; this source contract does not assume them.
const workspaceCorsOrigins = new Set(['https://app.capiro.ai', 'https://capiro.ai', 'https://www.capiro.ai']);
function responseHeaders(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('response headers required');
  const headers = new Map();
  for (const [key, value] of Object.entries(input)) {
    const name = key.toLowerCase();
    if (headers.has(name) || typeof value !== 'string') fail('ambiguous response header');
    headers.set(name, value);
  }
  return headers;
}
function origin(value) {
  // Admit only a literal canonical origin, optionally followed by one slash.
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) fail('noncanonical response origin');
  let parsed;
  try { parsed = new URL(value); } catch { fail('explicit response origin'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.href !== parsed.origin + '/' ||
      (value !== parsed.origin && value !== parsed.origin + '/') ||
      parsed.username || parsed.password) fail('noncanonical response origin');
  return parsed.origin;
}
/** Pure fake/recorded-response boundary. It performs no request and grants no
 * serving attestation. Dynamic buffers/tokens remain separate API/DB contracts.
 * HEAD models required future compatibility; it is not a deployed HEAD receipt.
 */
export function qualifyNewsletterResponse({ kind, url, method = 'GET', status, headers: rawHeaders,
  body, expectedOrigin = HISTORICAL_NEWSLETTER_ORIGIN, expectedBody, expectedMime,
  corsOrigin, identity = newsletterByteIdentity }) {
  const targetOrigin = origin(expectedOrigin);
  const allowedCorsOrigin = corsOrigin === undefined ? undefined : origin(corsOrigin);
  if (allowedCorsOrigin !== undefined && (corsOrigin !== allowedCorsOrigin ||
      kind !== 'upload' || !workspaceCorsOrigins.has(allowedCorsOrigin)))
    fail('CORS origin/credentials');
  let parsed;
  try { parsed = new URL(url); } catch { fail('response URL'); }
  if (typeof url !== 'string' || url !== parsed.href || parsed.origin !== targetOrigin || parsed.username || parsed.password || parsed.hash ||
      /[%\\\s]/.test(parsed.pathname)) fail('response origin/path mismatch');
  if (status !== 200 || !Buffer.isBuffer(body)) fail('successful raw response required');
  const headers = responseHeaders(rawHeaders);
  if (headers.has('location') || headers.has('www-authenticate')) fail('redirect/auth fallback');
  let required, expected, mime, allowed;
  if (kind === 'static') {
    expected = byUrl.get(parsed.pathname);
    if (!expected) fail('unknown static asset');
    mime = parsed.pathname.endsWith('.png') ? 'image/png' :
      parsed.pathname.endsWith('.svg') ? 'image/svg+xml' : 'text/plain';
    required = { 'x-content-type-options': 'nosniff' }; allowed = ['GET', 'HEAD'];
  } else if (kind === 'upload') {
    if (!/^\/workspace-api\/newsletters\/assets\/file\/[a-f0-9]{64}$/.test(parsed.pathname) ||
        !uploads.has(expectedMime) || !Number.isSafeInteger(expectedBody?.bytes) || expectedBody.bytes <= 0 ||
        !/^[a-f0-9]{64}$/.test(expectedBody?.sha256 ?? '')) fail('upload capability/body contract');
    required = NEWSLETTER_UPLOAD_HEADERS; expected = expectedBody; mime = expectedMime; allowed = ['GET', 'HEAD'];
  } else if (kind === 'capability') {
    const match = /^\/api\/engagement\/newsletter-public\/[a-f0-9]{64}\/(archive|unsubscribe|preferences|survey)$/.exec(parsed.pathname);
    if (!match) fail('public capability route required');
    required = NEWSLETTER_CAPABILITY_HEADERS;
    allowed = match[1] === 'archive' ? ['GET', 'HEAD'] : ['GET', 'HEAD', 'POST'];
  } else fail('response contract kind');
  if (!allowed.includes(method)) fail('response method');
  for (const [name, value] of Object.entries(required)) if (headers.get(name) !== value) fail(`header ${name}`);
  if (mime && headers.get('content-type')?.split(';')[0].trim() !== mime) fail('content-type');
  if (method === 'HEAD') {
    if (body.length !== 0) fail('HEAD body must be empty');
    if (expected && headers.has('content-length') && headers.get('content-length') !== String(expected.bytes)) fail('HEAD length');
  } else if (expected && !sameIdentity(identity(body, parsed.pathname), expected, kind === 'static')) fail('response byte identity');
  if (allowedCorsOrigin !== undefined) {
    // Workspace bootstrap reflects explicitly admitted origins with credentials.
    if (headers.get('access-control-allow-origin') !== allowedCorsOrigin ||
        headers.get('access-control-allow-credentials') !== 'true') fail('CORS origin/credentials');
  }
  return Object.freeze({ sourceOnly: true, responseContractVerified: true,
    historicalOriginContract: targetOrigin === HISTORICAL_NEWSLETTER_ORIGIN,
    actualArtifactBytesVerified: Boolean(expected && method !== 'HEAD' && identity === newsletterByteIdentity),
    deployedServingVerified: false, dynamicStorageOrCapabilityVerified: false,
    corsContractVerified: corsOrigin !== undefined });
}
export function parseNewsletterContractInvocation(args) {
  if (args.length === 0) return 'source';
  if (args.length === 1 && args[0] === '--frontend-parity') return 'frontend-parity';
  fail('expected no arguments or exact --frontend-parity');
}
