var PackedNewsletter = (() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __commonJS = (cb, mod) => function __require2() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // node_modules/@capiro/shared/dist/newsletter-fonts.catalog.js
  var require_newsletter_fonts_catalog = __commonJS({
    "node_modules/@capiro/shared/dist/newsletter-fonts.catalog.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.NEWSLETTER_FONT_RECORDS = void 0;
      exports.NEWSLETTER_FONT_RECORDS = [
        ["ABeeZee", "ABeeZee", 400, false],
        ["ABeeZee Italic", "ABeeZee", 400, true],
        ["Abel", "Abel", 400, false],
        ["Abhaya Libre", "Abhaya Libre", 400, false],
        ["Abhaya Libre Bold", "Abhaya Libre", 700, false],
        ["Abhaya Libre Extra Bold", "Abhaya Libre", 800, false],
        ["Abhaya Libre Medium", "Abhaya Libre", 500, false],
        ["Abhaya Libre Semi Bold", "Abhaya Libre", 600, false],
        ["Abril Fatface", "Abril Fatface", 400, false],
        ["Aclonica", "Aclonica", 400, false],
        ["Acme", "Acme", 400, false],
        ["Actor", "Actor", 400, false],
        ["Adamina", "Adamina", 400, false],
        ["Advent Pro", "Advent Pro", 400, false],
        ["Advent Pro Bold", "Advent Pro", 700, false],
        ["Advent Pro Extra Light", "Advent Pro", 200, false],
        ["Advent Pro Light", "Advent Pro", 300, false],
        ["Advent Pro Medium", "Advent Pro", 500, false],
        ["Advent Pro Semi Bold", "Advent Pro", 600, false],
        ["Advent Pro Thin", "Advent Pro", 100, false],
        ["Aguafina Script", "Aguafina Script", 400, false],
        ["Akronim", "Akronim", 400, false],
        ["Aladin", "Aladin", 400, false],
        ["Aldrich", "Aldrich", 400, false],
        ["Alef", "Alef", 400, false],
        ["Alef Bold", "Alef", 700, false],
        ["Alegreya", "Alegreya", 400, false],
        ["Alegreya Black", "Alegreya", 900, false],
        ["Alegreya Black Italic", "Alegreya", 900, true],
        ["Alegreya Bold", "Alegreya", 700, false],
        ["Alegreya Bold Italic", "Alegreya", 700, true],
        ["Alegreya Italic", "Alegreya", 400, true],
        ["Alegreya Sans", "Alegreya Sans", 400, false],
        ["Alegreya Sans Black", "Alegreya Sans", 900, false],
        ["Alegreya Sans Black Italic", "Alegreya Sans", 900, true],
        ["Alegreya Sans Bold", "Alegreya Sans", 700, false],
        ["Alegreya Sans Bold Italic", "Alegreya Sans", 700, true],
        ["Alegreya Sans Extra Bold", "Alegreya Sans", 800, false],
        ["Alegreya Sans Extra Bold Italic", "Alegreya Sans", 800, true],
        ["Alegreya Sans Italic", "Alegreya Sans", 400, true],
        ["Alegreya Sans Light", "Alegreya Sans", 300, false],
        ["Alegreya Sans Light Italic", "Alegreya Sans", 300, true],
        ["Alegreya Sans Medium", "Alegreya Sans", 500, false],
        ["Alegreya Sans Medium Italic", "Alegreya Sans", 500, true],
        ["Alegreya Sans SC", "Alegreya Sans SC", 400, false],
        ["Alegreya Sans SC Black", "Alegreya Sans SC", 900, false],
        ["Alegreya Sans SC Black Italic", "Alegreya Sans SC", 900, true],
        ["Alegreya Sans SC Bold", "Alegreya Sans SC", 700, false],
        ["Alegreya Sans SC Bold Italic", "Alegreya Sans SC", 700, true],
        ["Alegreya Sans SC Extra Bold", "Alegreya Sans SC", 800, false],
        ["Alegreya Sans SC Extra Bold Italic", "Alegreya Sans SC", 800, true],
        ["Alegreya Sans SC Italic", "Alegreya Sans SC", 400, true],
        ["Alegreya Sans SC Light", "Alegreya Sans SC", 300, false],
        ["Alegreya Sans SC Light Italic", "Alegreya Sans SC", 300, true],
        ["Alegreya Sans SC Medium", "Alegreya Sans SC", 500, false],
        ["Alegreya Sans SC Medium Italic", "Alegreya Sans SC", 500, true],
        ["Alegreya Sans SC Thin", "Alegreya Sans SC", 100, false],
        ["Alegreya Sans SC Thin Italic", "Alegreya Sans SC", 100, true],
        ["Alegreya Sans Thin", "Alegreya Sans", 100, false],
        ["Alegreya Sans Thin Italic", "Alegreya Sans", 100, true],
        ["Alegreya SC", "Alegreya SC", 400, false],
        ["Alegreya SC Black", "Alegreya SC", 900, false],
        ["Alegreya SC Black Italic", "Alegreya SC", 900, true],
        ["Alegreya SC Bold", "Alegreya SC", 700, false],
        ["Alegreya SC Bold Italic", "Alegreya SC", 700, true],
        ["Alegreya SC Italic", "Alegreya SC", 400, true],
        ["Alex Brush", "Alex Brush", 400, false],
        ["Alfa Slab One", "Alfa Slab One", 400, false],
        ["Alice", "Alice", 400, false],
        ["Alike", "Alike", 400, false],
        ["Alike Angular", "Alike Angular", 400, false],
        ["Allan", "Allan", 400, false],
        ["Allan Bold", "Allan", 700, false],
        ["Allerta", "Allerta", 400, false],
        ["Allerta Stencil", "Allerta Stencil", 400, false],
        ["Allura", "Allura", 400, false],
        ["Almendra", "Almendra", 400, false],
        ["Almendra Bold", "Almendra", 700, false],
        ["Almendra Bold Italic", "Almendra", 700, true],
        ["Almendra Display", "Almendra Display", 400, false],
        ["Almendra Italic", "Almendra", 400, true],
        ["Almendra SC", "Almendra SC", 400, false],
        ["Amarante", "Amarante", 400, false],
        ["Amaranth", "Amaranth", 400, false],
        ["Amaranth Bold", "Amaranth", 700, false],
        ["Amaranth Bold Italic", "Amaranth", 700, true],
        ["Amaranth Italic", "Amaranth", 400, true],
        ["Amatic SC", "Amatic SC", 400, false],
        ["Amatic SC Bold", "Amatic SC", 700, false],
        ["Amatica SC", "Amatica SC", 400, false],
        ["Amatica SC Bold", "Amatica SC", 700, false],
        ["Amethysta", "Amethysta", 400, false],
        ["Amiko", "Amiko", 400, false],
        ["Amiko Bold", "Amiko", 700, false],
        ["Amiko Semi Bold", "Amiko", 600, false],
        ["Amiri", "Amiri", 400, false],
        ["Amiri Bold", "Amiri", 700, false],
        ["Amiri Bold Italic", "Amiri", 700, true],
        ["Amiri Italic", "Amiri", 400, true],
        ["Amita", "Amita", 400, false],
        ["Amita Bold", "Amita", 700, false],
        ["Anaheim", "Anaheim", 400, false],
        ["Andada", "Andada", 400, false],
        ["Andika", "Andika", 400, false],
        ["Angkor", "Angkor", 400, false],
        ["Annie Use Your Telescope", "Annie Use Your Telescope", 400, false],
        ["Anonymous Pro", "Anonymous Pro", 400, false],
        ["Anonymous Pro Bold", "Anonymous Pro", 700, false],
        ["Anonymous Pro Bold Italic", "Anonymous Pro", 700, true],
        ["Anonymous Pro Italic", "Anonymous Pro", 400, true],
        ["Antic", "Antic", 400, false],
        ["Antic Didone", "Antic Didone", 400, false],
        ["Antic Slab", "Antic Slab", 400, false],
        ["Anton", "Anton", 400, false],
        ["Arapey", "Arapey", 400, false],
        ["Arapey Italic", "Arapey", 400, true],
        ["Arbutus", "Arbutus", 400, false],
        ["Arbutus Slab", "Arbutus Slab", 400, false],
        ["Architects Daughter", "Architects Daughter", 400, false],
        ["Archivo Black", "Archivo Black", 400, false],
        ["Archivo Narrow", "Archivo Narrow", 400, false],
        ["Archivo Narrow Bold", "Archivo Narrow", 700, false],
        ["Archivo Narrow Bold Italic", "Archivo Narrow", 700, true],
        ["Archivo Narrow Italic", "Archivo Narrow", 400, true],
        ["Aref Ruqaa", "Aref Ruqaa", 400, false],
        ["Aref Ruqaa Bold", "Aref Ruqaa", 700, false],
        ["Arial", "Arial", 400, false],
        ["Arial Bold", "Arial", 700, false],
        ["Arial Bold Italic", "Arial", 700, true],
        ["Arial Italic", "Arial", 400, true],
        ["Arima Madurai", "Arima Madurai", 400, false],
        ["Arima Madurai Black", "Arima Madurai", 900, false],
        ["Arima Madurai Bold", "Arima Madurai", 700, false],
        ["Arima Madurai Extra Bold", "Arima Madurai", 800, false],
        ["Arima Madurai Extra Light", "Arima Madurai", 200, false],
        ["Arima Madurai Light", "Arima Madurai", 300, false],
        ["Arima Madurai Medium", "Arima Madurai", 500, false],
        ["Arima Madurai Thin", "Arima Madurai", 100, false],
        ["Arimo", "Arimo", 400, false],
        ["Arimo Bold", "Arimo", 700, false],
        ["Arimo Bold Italic", "Arimo", 700, true],
        ["Arimo Italic", "Arimo", 400, true],
        ["Arizonia", "Arizonia", 400, false],
        ["Armata", "Armata", 400, false],
        ["Arsenal", "Arsenal", 400, false],
        ["Arsenal Bold", "Arsenal", 700, false],
        ["Arsenal Bold Italic", "Arsenal", 700, true],
        ["Arsenal Italic", "Arsenal", 400, true],
        ["Artifika", "Artifika", 400, false],
        ["Arvo", "Arvo", 400, false],
        ["Arvo Bold", "Arvo", 700, false],
        ["Arvo Bold Italic", "Arvo", 700, true],
        ["Arvo Italic", "Arvo", 400, true],
        ["Arya", "Arya", 400, false],
        ["Arya Bold", "Arya", 700, false],
        ["Asap", "Asap", 400, false],
        ["Asap Bold", "Asap", 700, false],
        ["Asap Bold Italic", "Asap", 700, true],
        ["Asap Italic", "Asap", 400, true],
        ["Asap Medium", "Asap", 500, false],
        ["Asap Medium Italic", "Asap", 500, true],
        ["Asar", "Asar", 400, false],
        ["Asset", "Asset", 400, false],
        ["Assistant", "Assistant", 400, false],
        ["Assistant Bold", "Assistant", 700, false],
        ["Assistant Extra Bold", "Assistant", 800, false],
        ["Assistant Extra Light", "Assistant", 200, false],
        ["Assistant Light", "Assistant", 300, false],
        ["Assistant Semi Bold", "Assistant", 600, false],
        ["Astloch", "Astloch", 400, false],
        ["Astloch Bold", "Astloch", 700, false],
        ["Asul", "Asul", 400, false],
        ["Asul Bold", "Asul", 700, false],
        ["Athiti", "Athiti", 400, false],
        ["Athiti Bold", "Athiti", 700, false],
        ["Athiti Extra Light", "Athiti", 200, false],
        ["Athiti Light", "Athiti", 300, false],
        ["Athiti Medium", "Athiti", 500, false],
        ["Athiti Semi Bold", "Athiti", 600, false],
        ["Atma", "Atma", 400, false],
        ["Atma Bold", "Atma", 700, false],
        ["Atma Light", "Atma", 300, false],
        ["Atma Medium", "Atma", 500, false],
        ["Atma Semi Bold", "Atma", 600, false],
        ["Atomic Age", "Atomic Age", 400, false],
        ["Aubrey", "Aubrey", 400, false],
        ["Audiowide", "Audiowide", 400, false],
        ["Autour One", "Autour One", 400, false],
        ["Average", "Average", 400, false],
        ["Average Sans", "Average Sans", 400, false],
        ["Averia Gruesa Libre", "Averia Gruesa Libre", 400, false],
        ["Averia Libre", "Averia Libre", 400, false],
        ["Averia Libre Bold", "Averia Libre", 700, false],
        ["Averia Libre Bold Italic", "Averia Libre", 700, true],
        ["Averia Libre Italic", "Averia Libre", 400, true],
        ["Averia Libre Light", "Averia Libre", 300, false],
        ["Averia Libre Light Italic", "Averia Libre", 300, true],
        ["Averia Sans Libre", "Averia Sans Libre", 400, false],
        ["Averia Sans Libre Bold", "Averia Sans Libre", 700, false],
        ["Averia Sans Libre Bold Italic", "Averia Sans Libre", 700, true],
        ["Averia Sans Libre Italic", "Averia Sans Libre", 400, true],
        ["Averia Sans Libre Light", "Averia Sans Libre", 300, false],
        ["Averia Sans Libre Light Italic", "Averia Sans Libre", 300, true],
        ["Averia Serif Libre", "Averia Serif Libre", 400, false],
        ["Averia Serif Libre Bold", "Averia Serif Libre", 700, false],
        ["Averia Serif Libre Bold Italic", "Averia Serif Libre", 700, true],
        ["Averia Serif Libre Italic", "Averia Serif Libre", 400, true],
        ["Averia Serif Libre Light", "Averia Serif Libre", 300, false],
        ["Averia Serif Libre Light Italic", "Averia Serif Libre", 300, true],
        ["Bad Script", "Bad Script", 400, false],
        ["Bahiana", "Bahiana", 400, false],
        ["Baloo", "Baloo", 400, false],
        ["Baloo Bhai", "Baloo Bhai", 400, false],
        ["Baloo Bhaina", "Baloo Bhaina", 400, false],
        ["Baloo Chettan", "Baloo Chettan", 400, false],
        ["Baloo Da", "Baloo Da", 400, false],
        ["Baloo Paaji", "Baloo Paaji", 400, false],
        ["Baloo Tamma", "Baloo Tamma", 400, false],
        ["Baloo Thambi", "Baloo Thambi", 400, false],
        ["Balthazar", "Balthazar", 400, false],
        ["Bangers", "Bangers", 400, false],
        ["Barrio", "Barrio", 400, false],
        ["Basic", "Basic", 400, false],
        ["Battambang", "Battambang", 400, false],
        ["Battambang Bold", "Battambang", 700, false],
        ["Baumans", "Baumans", 400, false],
        ["Bayon", "Bayon", 400, false],
        ["Belgrano", "Belgrano", 400, false],
        ["Belleza", "Belleza", 400, false],
        ["BenchNine", "BenchNine", 400, false],
        ["BenchNine Bold", "BenchNine", 700, false],
        ["BenchNine Light", "BenchNine", 300, false],
        ["Bentham", "Bentham", 400, false],
        ["Berkshire Swash", "Berkshire Swash", 400, false],
        ["Bevan", "Bevan", 400, false],
        ["Bigelow Rules", "Bigelow Rules", 400, false],
        ["Bigshot One", "Bigshot One", 400, false],
        ["Bilbo", "Bilbo", 400, false],
        ["Bilbo Swash Caps", "Bilbo Swash Caps", 400, false],
        ["BioRhyme", "BioRhyme", 400, false],
        ["BioRhyme Bold", "BioRhyme", 700, false],
        ["BioRhyme Expanded", "BioRhyme Expanded", 400, false],
        ["BioRhyme Expanded Bold", "BioRhyme Expanded", 700, false],
        ["BioRhyme Expanded Extra Bold", "BioRhyme Expanded", 800, false],
        ["BioRhyme Expanded Extra Light", "BioRhyme Expanded", 200, false],
        ["BioRhyme Expanded Light", "BioRhyme Expanded", 300, false],
        ["BioRhyme Extra Bold", "BioRhyme", 800, false],
        ["BioRhyme Extra Light", "BioRhyme", 200, false],
        ["BioRhyme Light", "BioRhyme", 300, false],
        ["Biryani", "Biryani", 400, false],
        ["Biryani Black", "Biryani", 900, false],
        ["Biryani Bold", "Biryani", 700, false],
        ["Biryani Extra Bold", "Biryani", 800, false],
        ["Biryani Extra Light", "Biryani", 200, false],
        ["Biryani Light", "Biryani", 300, false],
        ["Biryani Semi Bold", "Biryani", 600, false],
        ["Bitter", "Bitter", 400, false],
        ["Bitter Bold", "Bitter", 700, false],
        ["Bitter Italic", "Bitter", 400, true],
        ["Black Ops One", "Black Ops One", 400, false],
        ["Bokor", "Bokor", 400, false],
        ["Bonbon", "Bonbon", 400, false],
        ["Boogaloo", "Boogaloo", 400, false],
        ["Bowlby One", "Bowlby One", 400, false],
        ["Bowlby One SC", "Bowlby One SC", 400, false],
        ["Brawler", "Brawler", 400, false],
        ["Bree Serif", "Bree Serif", 400, false],
        ["Bubblegum Sans", "Bubblegum Sans", 400, false],
        ["Bubbler One", "Bubbler One", 400, false],
        ["Buda Light", "Buda", 300, false],
        ["Buenard", "Buenard", 400, false],
        ["Buenard Bold", "Buenard", 700, false],
        ["Bungee", "Bungee", 400, false],
        ["Bungee Hairline", "Bungee Hairline", 400, false],
        ["Bungee Inline", "Bungee Inline", 400, false],
        ["Bungee Outline", "Bungee Outline", 400, false],
        ["Bungee Shade", "Bungee Shade", 400, false],
        ["Butcherman", "Butcherman", 400, false],
        ["Butterfly Kids", "Butterfly Kids", 400, false],
        ["Cabin", "Cabin", 400, false],
        ["Cabin Bold", "Cabin", 700, false],
        ["Cabin Bold Italic", "Cabin", 700, true],
        ["Cabin Condensed", "Cabin Condensed", 400, false],
        ["Cabin Condensed Bold", "Cabin Condensed", 700, false],
        ["Cabin Condensed Medium", "Cabin Condensed", 500, false],
        ["Cabin Condensed Semi Bold", "Cabin Condensed", 600, false],
        ["Cabin Italic", "Cabin", 400, true],
        ["Cabin Medium", "Cabin", 500, false],
        ["Cabin Medium Italic", "Cabin", 500, true],
        ["Cabin Semi Bold", "Cabin", 600, false],
        ["Cabin Semi Bold Italic", "Cabin", 600, true],
        ["Cabin Sketch", "Cabin Sketch", 400, false],
        ["Cabin Sketch Bold", "Cabin Sketch", 700, false],
        ["Caesar Dressing", "Caesar Dressing", 400, false],
        ["Cagliostro", "Cagliostro", 400, false],
        ["Cairo", "Cairo", 400, false],
        ["Cairo Black", "Cairo", 900, false],
        ["Cairo Bold", "Cairo", 700, false],
        ["Cairo Extra Light", "Cairo", 200, false],
        ["Cairo Light", "Cairo", 300, false],
        ["Cairo Semi Bold", "Cairo", 600, false],
        ["Calligraffitti", "Calligraffitti", 400, false],
        ["Cambay", "Cambay", 400, false],
        ["Cambay Bold", "Cambay", 700, false],
        ["Cambay Bold Italic", "Cambay", 700, true],
        ["Cambay Italic", "Cambay", 400, true],
        ["Cambo", "Cambo", 400, false],
        ["Candal", "Candal", 400, false],
        ["Cantarell", "Cantarell", 400, false],
        ["Cantarell Bold", "Cantarell", 700, false],
        ["Cantarell Bold Italic", "Cantarell", 700, true],
        ["Cantarell Italic", "Cantarell", 400, true],
        ["Cantata One", "Cantata One", 400, false],
        ["Cantora One", "Cantora One", 400, false],
        ["Capriola", "Capriola", 400, false],
        ["Cardo", "Cardo", 400, false],
        ["Cardo Bold", "Cardo", 700, false],
        ["Cardo Italic", "Cardo", 400, true],
        ["Carme", "Carme", 400, false],
        ["Carrois Gothic", "Carrois Gothic", 400, false],
        ["Carrois Gothic SC", "Carrois Gothic SC", 400, false],
        ["Carter One", "Carter One", 400, false],
        ["Catamaran", "Catamaran", 400, false],
        ["Catamaran Black", "Catamaran", 900, false],
        ["Catamaran Bold", "Catamaran", 700, false],
        ["Catamaran Extra Bold", "Catamaran", 800, false],
        ["Catamaran Extra Light", "Catamaran", 200, false],
        ["Catamaran Light", "Catamaran", 300, false],
        ["Catamaran Medium", "Catamaran", 500, false],
        ["Catamaran Semi Bold", "Catamaran", 600, false],
        ["Catamaran Thin", "Catamaran", 100, false],
        ["Caudex", "Caudex", 400, false],
        ["Caudex Bold", "Caudex", 700, false],
        ["Caudex Bold Italic", "Caudex", 700, true],
        ["Caudex Italic", "Caudex", 400, true],
        ["Caveat", "Caveat", 400, false],
        ["Caveat Bold", "Caveat", 700, false],
        ["Caveat Brush", "Caveat Brush", 400, false],
        ["Cedarville Cursive", "Cedarville Cursive", 400, false],
        ["Ceviche One", "Ceviche One", 400, false],
        ["Changa", "Changa", 400, false],
        ["Changa Bold", "Changa", 700, false],
        ["Changa Extra Bold", "Changa", 800, false],
        ["Changa Extra Light", "Changa", 200, false],
        ["Changa Light", "Changa", 300, false],
        ["Changa Medium", "Changa", 500, false],
        ["Changa One", "Changa One", 400, false],
        ["Changa One Italic", "Changa One", 400, true],
        ["Changa Semi Bold", "Changa", 600, false],
        ["Chango", "Chango", 400, false],
        ["Chathura", "Chathura", 400, false],
        ["Chathura Bold", "Chathura", 700, false],
        ["Chathura Extra Bold", "Chathura", 800, false],
        ["Chathura Light", "Chathura", 300, false],
        ["Chathura Thin", "Chathura", 100, false],
        ["Chau Philomene One", "Chau Philomene One", 400, false],
        ["Chau Philomene One Italic", "Chau Philomene One", 400, true],
        ["Chela One", "Chela One", 400, false],
        ["Chelsea Market", "Chelsea Market", 400, false],
        ["Chenla", "Chenla", 400, false],
        ["Cherry Cream Soda", "Cherry Cream Soda", 400, false],
        ["Cherry Swash", "Cherry Swash", 400, false],
        ["Cherry Swash Bold", "Cherry Swash", 700, false],
        ["Chewy", "Chewy", 400, false],
        ["Chicle", "Chicle", 400, false],
        ["Chivo", "Chivo", 400, false],
        ["Chivo Black", "Chivo", 900, false],
        ["Chivo Black Italic", "Chivo", 900, true],
        ["Chivo Bold", "Chivo", 700, false],
        ["Chivo Bold Italic", "Chivo", 700, true],
        ["Chivo Italic", "Chivo", 400, true],
        ["Chivo Light", "Chivo", 300, false],
        ["Chivo Light Italic", "Chivo", 300, true],
        ["Chonburi", "Chonburi", 400, false],
        ["Cinzel", "Cinzel", 400, false],
        ["Cinzel Black", "Cinzel", 900, false],
        ["Cinzel Bold", "Cinzel", 700, false],
        ["Cinzel Decorative", "Cinzel Decorative", 400, false],
        ["Cinzel Decorative Black", "Cinzel Decorative", 900, false],
        ["Cinzel Decorative Bold", "Cinzel Decorative", 700, false],
        ["Clicker Script", "Clicker Script", 400, false],
        ["Coda", "Coda", 400, false],
        ["Coda Caption Extra Bold", "Coda Caption", 800, false],
        ["Coda Extra Bold", "Coda", 800, false],
        ["Codystar", "Codystar", 400, false],
        ["Codystar Light", "Codystar", 300, false],
        ["Coiny", "Coiny", 400, false],
        ["Combo", "Combo", 400, false],
        ["Comfortaa", "Comfortaa", 400, false],
        ["Comfortaa Bold", "Comfortaa", 700, false],
        ["Comfortaa Light", "Comfortaa", 300, false],
        ["Comic Sans MS", "Comic Sans MS", 400, false],
        ["Comic Sans MS Bold", "Comic Sans MS", 700, false],
        ["Comic Sans MS Bold Italic", "Comic Sans MS", 700, true],
        ["Comic Sans MS Italic", "Comic Sans MS", 400, true],
        ["Coming Soon", "Coming Soon", 400, false],
        ["Concert One", "Concert One", 400, false],
        ["Condiment", "Condiment", 400, false],
        ["Content", "Content", 400, false],
        ["Content Bold", "Content", 700, false],
        ["Contrail One", "Contrail One", 400, false],
        ["Convergence", "Convergence", 400, false],
        ["Cookie", "Cookie", 400, false],
        ["Copse", "Copse", 400, false],
        ["Corben", "Corben", 400, false],
        ["Corben Bold", "Corben", 700, false],
        ["Cormorant", "Cormorant", 400, false],
        ["Cormorant Bold", "Cormorant", 700, false],
        ["Cormorant Bold Italic", "Cormorant", 700, true],
        ["Cormorant Garamond", "Cormorant Garamond", 400, false],
        ["Cormorant Garamond Bold", "Cormorant Garamond", 700, false],
        ["Cormorant Garamond Bold Italic", "Cormorant Garamond", 700, true],
        ["Cormorant Garamond Italic", "Cormorant Garamond", 400, true],
        ["Cormorant Garamond Light", "Cormorant Garamond", 300, false],
        ["Cormorant Garamond Light Italic", "Cormorant Garamond", 300, true],
        ["Cormorant Garamond Medium", "Cormorant Garamond", 500, false],
        ["Cormorant Garamond Medium Italic", "Cormorant Garamond", 500, true],
        ["Cormorant Garamond Semi Bold", "Cormorant Garamond", 600, false],
        ["Cormorant Garamond Semi Bold Italic", "Cormorant Garamond", 600, true],
        ["Cormorant Infant", "Cormorant Infant", 400, false],
        ["Cormorant Infant Bold", "Cormorant Infant", 700, false],
        ["Cormorant Infant Bold Italic", "Cormorant Infant", 700, true],
        ["Cormorant Infant Italic", "Cormorant Infant", 400, true],
        ["Cormorant Infant Light", "Cormorant Infant", 300, false],
        ["Cormorant Infant Light Italic", "Cormorant Infant", 300, true],
        ["Cormorant Infant Medium", "Cormorant Infant", 500, false],
        ["Cormorant Infant Medium Italic", "Cormorant Infant", 500, true],
        ["Cormorant Infant Semi Bold", "Cormorant Infant", 600, false],
        ["Cormorant Infant Semi Bold Italic", "Cormorant Infant", 600, true],
        ["Cormorant Italic", "Cormorant", 400, true],
        ["Cormorant Light", "Cormorant", 300, false],
        ["Cormorant Light Italic", "Cormorant", 300, true],
        ["Cormorant Medium", "Cormorant", 500, false],
        ["Cormorant Medium Italic", "Cormorant", 500, true],
        ["Cormorant SC", "Cormorant SC", 400, false],
        ["Cormorant SC Bold", "Cormorant SC", 700, false],
        ["Cormorant SC Light", "Cormorant SC", 300, false],
        ["Cormorant SC Medium", "Cormorant SC", 500, false],
        ["Cormorant SC Semi Bold", "Cormorant SC", 600, false],
        ["Cormorant Semi Bold", "Cormorant", 600, false],
        ["Cormorant Semi Bold Italic", "Cormorant", 600, true],
        ["Cormorant Unicase", "Cormorant Unicase", 400, false],
        ["Cormorant Unicase Bold", "Cormorant Unicase", 700, false],
        ["Cormorant Unicase Light", "Cormorant Unicase", 300, false],
        ["Cormorant Unicase Medium", "Cormorant Unicase", 500, false],
        ["Cormorant Unicase Semi Bold", "Cormorant Unicase", 600, false],
        ["Cormorant Upright", "Cormorant Upright", 400, false],
        ["Cormorant Upright Bold", "Cormorant Upright", 700, false],
        ["Cormorant Upright Light", "Cormorant Upright", 300, false],
        ["Cormorant Upright Medium", "Cormorant Upright", 500, false],
        ["Cormorant Upright Semi Bold", "Cormorant Upright", 600, false],
        ["Courgette", "Courgette", 400, false],
        ["Courier New", "Courier New", 400, false],
        ["Courier New Bold", "Courier New", 700, false],
        ["Courier New Bold Italic", "Courier New", 700, true],
        ["Courier New Italic", "Courier New", 400, true],
        ["Cousine", "Cousine", 400, false],
        ["Cousine Bold", "Cousine", 700, false],
        ["Cousine Bold Italic", "Cousine", 700, true],
        ["Cousine Italic", "Cousine", 400, true],
        ["Coustard", "Coustard", 400, false],
        ["Coustard Black", "Coustard", 900, false],
        ["Covered By Your Grace", "Covered By Your Grace", 400, false],
        ["Crafty Girls", "Crafty Girls", 400, false],
        ["Creepster", "Creepster", 400, false],
        ["Crete Round", "Crete Round", 400, false],
        ["Crete Round Italic", "Crete Round", 400, true],
        ["Crimson Text", "Crimson Text", 400, false],
        ["Crimson Text Bold", "Crimson Text", 700, false],
        ["Crimson Text Bold Italic", "Crimson Text", 700, true],
        ["Crimson Text Italic", "Crimson Text", 400, true],
        ["Crimson Text Semi Bold", "Crimson Text", 600, false],
        ["Crimson Text Semi Bold Italic", "Crimson Text", 600, true],
        ["Croissant One", "Croissant One", 400, false],
        ["Crushed", "Crushed", 400, false],
        ["Cuprum", "Cuprum", 400, false],
        ["Cuprum Bold", "Cuprum", 700, false],
        ["Cuprum Bold Italic", "Cuprum", 700, true],
        ["Cuprum Italic", "Cuprum", 400, true],
        ["Cutive", "Cutive", 400, false],
        ["Cutive Mono", "Cutive Mono", 400, false],
        ["Damion", "Damion", 400, false],
        ["Dancing Script", "Dancing Script", 400, false],
        ["Dancing Script Bold", "Dancing Script", 700, false],
        ["Dangrek", "Dangrek", 400, false],
        ["David Libre", "David Libre", 400, false],
        ["David Libre Bold", "David Libre", 700, false],
        ["David Libre Medium", "David Libre", 500, false],
        ["Dawning of a New Day", "Dawning of a New Day", 400, false],
        ["Days One", "Days One", 400, false],
        ["Dekko", "Dekko", 400, false],
        ["Delius", "Delius", 400, false],
        ["Delius Swash Caps", "Delius Swash Caps", 400, false],
        ["Delius Unicase", "Delius Unicase", 400, false],
        ["Delius Unicase Bold", "Delius Unicase", 700, false],
        ["Della Respira", "Della Respira", 400, false],
        ["Denk One", "Denk One", 400, false],
        ["Devonshire", "Devonshire", 400, false],
        ["Dhurjati", "Dhurjati", 400, false],
        ["Didact Gothic", "Didact Gothic", 400, false],
        ["Diplomata", "Diplomata", 400, false],
        ["Diplomata SC", "Diplomata SC", 400, false],
        ["Domine", "Domine", 400, false],
        ["Domine Bold", "Domine", 700, false],
        ["Donegal One", "Donegal One", 400, false],
        ["Doppio One", "Doppio One", 400, false],
        ["Dorsa", "Dorsa", 400, false],
        ["Dosis", "Dosis", 400, false],
        ["Dosis Bold", "Dosis", 700, false],
        ["Dosis Extra Bold", "Dosis", 800, false],
        ["Dosis Extra Light", "Dosis", 200, false],
        ["Dosis Light", "Dosis", 300, false],
        ["Dosis Medium", "Dosis", 500, false],
        ["Dosis Semi Bold", "Dosis", 600, false],
        ["Dr Sugiyama", "Dr Sugiyama", 400, false],
        ["Droid Sans", "Droid Sans", 400, false],
        ["Droid Sans Bold", "Droid Sans", 700, false],
        ["Droid Sans Mono", "Droid Sans Mono", 400, false],
        ["Droid Serif", "Droid Serif", 400, false],
        ["Droid Serif Bold", "Droid Serif", 700, false],
        ["Droid Serif Bold Italic", "Droid Serif", 700, true],
        ["Droid Serif Italic", "Droid Serif", 400, true],
        ["Duru Sans", "Duru Sans", 400, false],
        ["Dynalight", "Dynalight", 400, false],
        ["Eagle Lake", "Eagle Lake", 400, false],
        ["Eater", "Eater", 400, false],
        ["EB Garamond", "EB Garamond", 400, false],
        ["Economica", "Economica", 400, false],
        ["Economica Bold", "Economica", 700, false],
        ["Economica Bold Italic", "Economica", 700, true],
        ["Economica Italic", "Economica", 400, true],
        ["Eczar", "Eczar", 400, false],
        ["Eczar Bold", "Eczar", 700, false],
        ["Eczar Extra Bold", "Eczar", 800, false],
        ["Eczar Medium", "Eczar", 500, false],
        ["Eczar Semi Bold", "Eczar", 600, false],
        ["Ek Mukta", "Ek Mukta", 400, false],
        ["Ek Mukta Bold", "Ek Mukta", 700, false],
        ["Ek Mukta Extra Bold", "Ek Mukta", 800, false],
        ["Ek Mukta Extra Light", "Ek Mukta", 200, false],
        ["Ek Mukta Light", "Ek Mukta", 300, false],
        ["Ek Mukta Medium", "Ek Mukta", 500, false],
        ["Ek Mukta Semi Bold", "Ek Mukta", 600, false],
        ["El Messiri", "El Messiri", 400, false],
        ["El Messiri Bold", "El Messiri", 700, false],
        ["El Messiri Medium", "El Messiri", 500, false],
        ["El Messiri Semi Bold", "El Messiri", 600, false],
        ["Electrolize", "Electrolize", 400, false],
        ["Elsie", "Elsie", 400, false],
        ["Elsie Black", "Elsie", 900, false],
        ["Elsie Swash Caps", "Elsie Swash Caps", 400, false],
        ["Elsie Swash Caps Black", "Elsie Swash Caps", 900, false],
        ["Emblema One", "Emblema One", 400, false],
        ["Emilys Candy", "Emilys Candy", 400, false],
        ["Engagement", "Engagement", 400, false],
        ["Englebert", "Englebert", 400, false],
        ["Enriqueta", "Enriqueta", 400, false],
        ["Enriqueta Bold", "Enriqueta", 700, false],
        ["Erica One", "Erica One", 400, false],
        ["Esteban", "Esteban", 400, false],
        ["Euphoria Script", "Euphoria Script", 400, false],
        ["Ewert", "Ewert", 400, false],
        ["Exo", "Exo", 400, false],
        ["Exo 2", "", 400, false],
        ["Exo 2 Black", "", 900, false],
        ["Exo 2 Black Italic", "", 900, true],
        ["Exo 2 Bold", "", 700, false],
        ["Exo 2 Bold Italic", "", 700, true],
        ["Exo 2 Extra Bold", "", 800, false],
        ["Exo 2 Extra Bold Italic", "", 800, true],
        ["Exo 2 Extra Light", "", 200, false],
        ["Exo 2 Extra Light Italic", "", 200, true],
        ["Exo 2 Italic", "", 400, true],
        ["Exo 2 Light", "", 300, false],
        ["Exo 2 Light Italic", "", 300, true],
        ["Exo 2 Medium", "", 500, false],
        ["Exo 2 Medium Italic", "", 500, true],
        ["Exo 2 Semi Bold", "", 600, false],
        ["Exo 2 Semi Bold Italic", "", 600, true],
        ["Exo 2 Thin", "", 100, false],
        ["Exo 2 Thin Italic", "", 100, true],
        ["Exo Black", "Exo", 900, false],
        ["Exo Black Italic", "Exo", 900, true],
        ["Exo Bold", "Exo", 700, false],
        ["Exo Bold Italic", "Exo", 700, true],
        ["Exo Extra Bold", "Exo", 800, false],
        ["Exo Extra Bold Italic", "Exo", 800, true],
        ["Exo Extra Light", "Exo", 200, false],
        ["Exo Extra Light Italic", "Exo", 200, true],
        ["Exo Italic", "Exo", 400, true],
        ["Exo Light", "Exo", 300, false],
        ["Exo Light Italic", "Exo", 300, true],
        ["Exo Medium", "Exo", 500, false],
        ["Exo Medium Italic", "Exo", 500, true],
        ["Exo Semi Bold", "Exo", 600, false],
        ["Exo Semi Bold Italic", "Exo", 600, true],
        ["Exo Thin", "Exo", 100, false],
        ["Exo Thin Italic", "Exo", 100, true],
        ["Expletus Sans", "Expletus Sans", 400, false],
        ["Expletus Sans Bold", "Expletus Sans", 700, false],
        ["Expletus Sans Bold Italic", "Expletus Sans", 700, true],
        ["Expletus Sans Italic", "Expletus Sans", 400, true],
        ["Expletus Sans Medium", "Expletus Sans", 500, false],
        ["Expletus Sans Medium Italic", "Expletus Sans", 500, true],
        ["Expletus Sans Semi Bold", "Expletus Sans", 600, false],
        ["Expletus Sans Semi Bold Italic", "Expletus Sans", 600, true],
        ["Fanwood Text", "Fanwood Text", 400, false],
        ["Fanwood Text Italic", "Fanwood Text", 400, true],
        ["Farsan", "Farsan", 400, false],
        ["Fascinate", "Fascinate", 400, false],
        ["Fascinate Inline", "Fascinate Inline", 400, false],
        ["Faster One", "Faster One", 400, false],
        ["Fasthand", "Fasthand", 400, false],
        ["Fauna One", "Fauna One", 400, false],
        ["Federant", "Federant", 400, false],
        ["Federo", "Federo", 400, false],
        ["Felipa", "Felipa", 400, false],
        ["Fenix", "Fenix", 400, false],
        ["Finger Paint", "Finger Paint", 400, false],
        ["Fira Mono", "Fira Mono", 400, false],
        ["Fira Mono Bold", "Fira Mono", 700, false],
        ["Fira Mono Medium", "Fira Mono", 500, false],
        ["Fira Sans", "Fira Sans", 400, false],
        ["Fira Sans Black", "Fira Sans", 900, false],
        ["Fira Sans Black Italic", "Fira Sans", 900, true],
        ["Fira Sans Bold", "Fira Sans", 700, false],
        ["Fira Sans Bold Italic", "Fira Sans", 700, true],
        ["Fira Sans Condensed", "Fira Sans Condensed", 400, false],
        ["Fira Sans Condensed Black", "Fira Sans Condensed", 900, false],
        ["Fira Sans Condensed Black Italic", "Fira Sans Condensed", 900, true],
        ["Fira Sans Condensed Bold", "Fira Sans Condensed", 700, false],
        ["Fira Sans Condensed Bold Italic", "Fira Sans Condensed", 700, true],
        ["Fira Sans Condensed Extra Bold", "Fira Sans Condensed", 800, false],
        ["Fira Sans Condensed Extra Bold Italic", "Fira Sans Condensed", 800, true],
        ["Fira Sans Condensed Extra Light", "Fira Sans Condensed", 200, false],
        ["Fira Sans Condensed Extra Light Italic", "Fira Sans Condensed", 200, true],
        ["Fira Sans Condensed Italic", "Fira Sans Condensed", 400, true],
        ["Fira Sans Condensed Light", "Fira Sans Condensed", 300, false],
        ["Fira Sans Condensed Light Italic", "Fira Sans Condensed", 300, true],
        ["Fira Sans Condensed Medium", "Fira Sans Condensed", 500, false],
        ["Fira Sans Condensed Medium Italic", "Fira Sans Condensed", 500, true],
        ["Fira Sans Condensed Semi Bold", "Fira Sans Condensed", 600, false],
        ["Fira Sans Condensed Semi Bold Italic", "Fira Sans Condensed", 600, true],
        ["Fira Sans Condensed Thin", "Fira Sans Condensed", 100, false],
        ["Fira Sans Condensed Thin Italic", "Fira Sans Condensed", 100, true],
        ["Fira Sans Extra Bold", "Fira Sans", 800, false],
        ["Fira Sans Extra Bold Italic", "Fira Sans", 800, true],
        ["Fira Sans Extra Condensed", "Fira Sans Extra Condensed", 400, false],
        ["Fira Sans Extra Condensed Black", "Fira Sans Extra Condensed", 900, false],
        ["Fira Sans Extra Condensed Black Italic", "Fira Sans Extra Condensed", 900, true],
        ["Fira Sans Extra Condensed Bold", "Fira Sans Extra Condensed", 700, false],
        ["Fira Sans Extra Condensed Bold Italic", "Fira Sans Extra Condensed", 700, true],
        ["Fira Sans Extra Condensed Extra Bold", "Fira Sans Extra Condensed", 800, false],
        ["Fira Sans Extra Condensed Extra Bold Italic", "Fira Sans Extra Condensed", 800, true],
        ["Fira Sans Extra Condensed Extra Light", "Fira Sans Extra Condensed", 200, false],
        ["Fira Sans Extra Condensed Extra Light Italic", "Fira Sans Extra Condensed", 200, true],
        ["Fira Sans Extra Condensed Italic", "Fira Sans Extra Condensed", 400, true],
        ["Fira Sans Extra Condensed Light", "Fira Sans Extra Condensed", 300, false],
        ["Fira Sans Extra Condensed Light Italic", "Fira Sans Extra Condensed", 300, true],
        ["Fira Sans Extra Condensed Medium", "Fira Sans Extra Condensed", 500, false],
        ["Fira Sans Extra Condensed Medium Italic", "Fira Sans Extra Condensed", 500, true],
        ["Fira Sans Extra Condensed Semi Bold", "Fira Sans Extra Condensed", 600, false],
        ["Fira Sans Extra Condensed Semi Bold Italic", "Fira Sans Extra Condensed", 600, true],
        ["Fira Sans Extra Condensed Thin", "Fira Sans Extra Condensed", 100, false],
        ["Fira Sans Extra Condensed Thin Italic", "Fira Sans Extra Condensed", 100, true],
        ["Fira Sans Extra Light", "Fira Sans", 200, false],
        ["Fira Sans Extra Light Italic", "Fira Sans", 200, true],
        ["Fira Sans Italic", "Fira Sans", 400, true],
        ["Fira Sans Light", "Fira Sans", 300, false],
        ["Fira Sans Light Italic", "Fira Sans", 300, true],
        ["Fira Sans Medium", "Fira Sans", 500, false],
        ["Fira Sans Medium Italic", "Fira Sans", 500, true],
        ["Fira Sans Semi Bold", "Fira Sans", 600, false],
        ["Fira Sans Semi Bold Italic", "Fira Sans", 600, true],
        ["Fira Sans Thin", "Fira Sans", 100, false],
        ["Fira Sans Thin Italic", "Fira Sans", 100, true],
        ["Fjalla One", "Fjalla One", 400, false],
        ["Fjord One", "Fjord One", 400, false],
        ["Flamenco", "Flamenco", 400, false],
        ["Flamenco Light", "Flamenco", 300, false],
        ["Flavors", "Flavors", 400, false],
        ["Fondamento", "Fondamento", 400, false],
        ["Fondamento Italic", "Fondamento", 400, true],
        ["Fontdiner Swanky", "Fontdiner Swanky", 400, false],
        ["Forum", "Forum", 400, false],
        ["Francois One", "Francois One", 400, false],
        ["Frank Ruhl Libre", "Frank Ruhl Libre", 400, false],
        ["Frank Ruhl Libre Black", "Frank Ruhl Libre", 900, false],
        ["Frank Ruhl Libre Bold", "Frank Ruhl Libre", 700, false],
        ["Frank Ruhl Libre Light", "Frank Ruhl Libre", 300, false],
        ["Frank Ruhl Libre Medium", "Frank Ruhl Libre", 500, false],
        ["Freckle Face", "Freckle Face", 400, false],
        ["Fredericka the Great", "Fredericka the Great", 400, false],
        ["Fredoka One", "Fredoka One", 400, false],
        ["Freehand", "Freehand", 400, false],
        ["Fresca", "Fresca", 400, false],
        ["Frijole", "Frijole", 400, false],
        ["Fruktur", "Fruktur", 400, false],
        ["Fugaz One", "Fugaz One", 400, false],
        ["Gabriela", "Gabriela", 400, false],
        ["Gafata", "Gafata", 400, false],
        ["Galada", "Galada", 400, false],
        ["Galdeano", "Galdeano", 400, false],
        ["Galindo", "Galindo", 400, false],
        ["Gentium Basic", "Gentium Basic", 400, false],
        ["Gentium Basic Bold", "Gentium Basic", 700, false],
        ["Gentium Basic Bold Italic", "Gentium Basic", 700, true],
        ["Gentium Basic Italic", "Gentium Basic", 400, true],
        ["Gentium Book Basic", "Gentium Book Basic", 400, false],
        ["Gentium Book Basic Bold", "Gentium Book Basic", 700, false],
        ["Gentium Book Basic Bold Italic", "Gentium Book Basic", 700, true],
        ["Gentium Book Basic Italic", "Gentium Book Basic", 400, true],
        ["Geo", "Geo", 400, false],
        ["Geo Italic", "Geo", 400, true],
        ["Georgia", "Georgia", 400, false],
        ["Georgia Bold", "Georgia", 700, false],
        ["Georgia Bold Italic", "Georgia", 700, true],
        ["Georgia Italic", "Georgia", 400, true],
        ["Geostar", "Geostar", 400, false],
        ["Geostar Fill", "Geostar Fill", 400, false],
        ["Germania One", "Germania One", 400, false],
        ["GFS Didot", "GFS Didot", 400, false],
        ["GFS Neohellenic", "GFS Neohellenic", 400, false],
        ["GFS Neohellenic Bold", "GFS Neohellenic", 700, false],
        ["GFS Neohellenic Bold Italic", "GFS Neohellenic", 700, true],
        ["GFS Neohellenic Italic", "GFS Neohellenic", 400, true],
        ["Gidugu", "Gidugu", 400, false],
        ["Gilda Display", "Gilda Display", 400, false],
        ["Give You Glory", "Give You Glory", 400, false],
        ["Glass Antiqua", "Glass Antiqua", 400, false],
        ["Glegoo", "Glegoo", 400, false],
        ["Glegoo Bold", "Glegoo", 700, false],
        ["Gloria Hallelujah", "Gloria Hallelujah", 400, false],
        ["Goblin One", "Goblin One", 400, false],
        ["Gochi Hand", "Gochi Hand", 400, false],
        ["Gorditas", "Gorditas", 400, false],
        ["Gorditas Bold", "Gorditas", 700, false],
        ["Goudy Bookletter 1911", "", 400, false],
        ["Graduate", "Graduate", 400, false],
        ["Grand Hotel", "Grand Hotel", 400, false],
        ["Gravitas One", "Gravitas One", 400, false],
        ["Great Vibes", "Great Vibes", 400, false],
        ["Griffy", "Griffy", 400, false],
        ["Gruppo", "Gruppo", 400, false],
        ["Gudea", "Gudea", 400, false],
        ["Gudea Bold", "Gudea", 700, false],
        ["Gudea Italic", "Gudea", 400, true],
        ["Gurajada", "Gurajada", 400, false],
        ["Habibi", "Habibi", 400, false],
        ["Halant", "Halant", 400, false],
        ["Halant Bold", "Halant", 700, false],
        ["Halant Light", "Halant", 300, false],
        ["Halant Medium", "Halant", 500, false],
        ["Halant Semi Bold", "Halant", 600, false],
        ["Hammersmith One", "Hammersmith One", 400, false],
        ["Hanalei", "Hanalei", 400, false],
        ["Hanalei Fill", "Hanalei Fill", 400, false],
        ["Handlee", "Handlee", 400, false],
        ["Hanuman", "Hanuman", 400, false],
        ["Hanuman Bold", "Hanuman", 700, false],
        ["Happy Monkey", "Happy Monkey", 400, false],
        ["Harmattan", "Harmattan", 400, false],
        ["Headland One", "Headland One", 400, false],
        ["Heebo", "Heebo", 400, false],
        ["Heebo Black", "Heebo", 900, false],
        ["Heebo Bold", "Heebo", 700, false],
        ["Heebo Extra Bold", "Heebo", 800, false],
        ["Heebo Light", "Heebo", 300, false],
        ["Heebo Medium", "Heebo", 500, false],
        ["Heebo Thin", "Heebo", 100, false],
        ["Helvetica", "Helvetica", 400, false],
        ["Helvetica Bold", "Helvetica", 700, false],
        ["Helvetica Bold Italic", "Helvetica", 700, true],
        ["Helvetica Italic", "Helvetica", 400, true],
        ["Henny Penny", "Henny Penny", 400, false],
        ["Herr Von Muellerhoff", "Herr Von Muellerhoff", 400, false],
        ["Hind", "Hind", 400, false],
        ["Hind Bold", "Hind", 700, false],
        ["Hind Guntur", "Hind Guntur", 400, false],
        ["Hind Guntur Bold", "Hind Guntur", 700, false],
        ["Hind Guntur Light", "Hind Guntur", 300, false],
        ["Hind Guntur Medium", "Hind Guntur", 500, false],
        ["Hind Guntur Semi Bold", "Hind Guntur", 600, false],
        ["Hind Light", "Hind", 300, false],
        ["Hind Madurai", "Hind Madurai", 400, false],
        ["Hind Madurai Bold", "Hind Madurai", 700, false],
        ["Hind Madurai Light", "Hind Madurai", 300, false],
        ["Hind Madurai Medium", "Hind Madurai", 500, false],
        ["Hind Madurai Semi Bold", "Hind Madurai", 600, false],
        ["Hind Medium", "Hind", 500, false],
        ["Hind Semi Bold", "Hind", 600, false],
        ["Hind Siliguri", "Hind Siliguri", 400, false],
        ["Hind Siliguri Bold", "Hind Siliguri", 700, false],
        ["Hind Siliguri Light", "Hind Siliguri", 300, false],
        ["Hind Siliguri Medium", "Hind Siliguri", 500, false],
        ["Hind Siliguri Semi Bold", "Hind Siliguri", 600, false],
        ["Hind Vadodara", "Hind Vadodara", 400, false],
        ["Hind Vadodara Bold", "Hind Vadodara", 700, false],
        ["Hind Vadodara Light", "Hind Vadodara", 300, false],
        ["Hind Vadodara Medium", "Hind Vadodara", 500, false],
        ["Hind Vadodara Semi Bold", "Hind Vadodara", 600, false],
        ["Holtwood One SC", "Holtwood One SC", 400, false],
        ["Homemade Apple", "Homemade Apple", 400, false],
        ["Homenaje", "Homenaje", 400, false],
        ["Iceberg", "Iceberg", 400, false],
        ["Iceland", "Iceland", 400, false],
        ["IM Fell Double Pica", "IM Fell Double Pica", 400, false],
        ["IM Fell Double Pica Italic", "IM Fell Double Pica", 400, true],
        ["IM Fell Double Pica SC", "IM Fell Double Pica SC", 400, false],
        ["IM Fell DW Pica", "IM Fell DW Pica", 400, false],
        ["IM Fell DW Pica Italic", "IM Fell DW Pica", 400, true],
        ["IM Fell DW Pica SC", "IM Fell DW Pica SC", 400, false],
        ["IM Fell English", "IM Fell English", 400, false],
        ["IM Fell English Italic", "IM Fell English", 400, true],
        ["IM Fell English SC", "IM Fell English SC", 400, false],
        ["IM Fell French Canon", "IM Fell French Canon", 400, false],
        ["IM Fell French Canon Italic", "IM Fell French Canon", 400, true],
        ["IM Fell French Canon SC", "IM Fell French Canon SC", 400, false],
        ["IM Fell Great Primer", "IM Fell Great Primer", 400, false],
        ["IM Fell Great Primer Italic", "IM Fell Great Primer", 400, true],
        ["IM Fell Great Primer SC", "IM Fell Great Primer SC", 400, false],
        ["Imprima", "Imprima", 400, false],
        ["Inconsolata", "Inconsolata", 400, false],
        ["Inconsolata Bold", "Inconsolata", 700, false],
        ["Inder", "Inder", 400, false],
        ["Indie Flower", "Indie Flower", 400, false],
        ["Inika", "Inika", 400, false],
        ["Inika Bold", "Inika", 700, false],
        ["Inknut Antiqua", "Inknut Antiqua", 400, false],
        ["Inknut Antiqua Black", "Inknut Antiqua", 900, false],
        ["Inknut Antiqua Bold", "Inknut Antiqua", 700, false],
        ["Inknut Antiqua Extra Bold", "Inknut Antiqua", 800, false],
        ["Inknut Antiqua Light", "Inknut Antiqua", 300, false],
        ["Inknut Antiqua Medium", "Inknut Antiqua", 500, false],
        ["Inknut Antiqua Semi Bold", "Inknut Antiqua", 600, false],
        ["Irish Grover", "Irish Grover", 400, false],
        ["Istok Web", "Istok Web", 400, false],
        ["Istok Web Bold", "Istok Web", 700, false],
        ["Istok Web Bold Italic", "Istok Web", 700, true],
        ["Istok Web Italic", "Istok Web", 400, true],
        ["Italiana", "Italiana", 400, false],
        ["Italianno", "Italianno", 400, false],
        ["Itim", "Itim", 400, false],
        ["Jacques Francois", "Jacques Francois", 400, false],
        ["Jacques Francois Shadow", "Jacques Francois Shadow", 400, false],
        ["Jaldi", "Jaldi", 400, false],
        ["Jaldi Bold", "Jaldi", 700, false],
        ["Jim Nightshade", "Jim Nightshade", 400, false],
        ["Jockey One", "Jockey One", 400, false],
        ["Jolly Lodger", "Jolly Lodger", 400, false],
        ["Jomhuria", "Jomhuria", 400, false],
        ["Josefin Sans", "Josefin Sans", 400, false],
        ["Josefin Sans Bold", "Josefin Sans", 700, false],
        ["Josefin Sans Bold Italic", "Josefin Sans", 700, true],
        ["Josefin Sans Italic", "Josefin Sans", 400, true],
        ["Josefin Sans Light", "Josefin Sans", 300, false],
        ["Josefin Sans Light Italic", "Josefin Sans", 300, true],
        ["Josefin Sans Semi Bold", "Josefin Sans", 600, false],
        ["Josefin Sans Semi Bold Italic", "Josefin Sans", 600, true],
        ["Josefin Sans Thin", "Josefin Sans", 100, false],
        ["Josefin Sans Thin Italic", "Josefin Sans", 100, true],
        ["Josefin Slab", "Josefin Slab", 400, false],
        ["Josefin Slab Bold", "Josefin Slab", 700, false],
        ["Josefin Slab Bold Italic", "Josefin Slab", 700, true],
        ["Josefin Slab Italic", "Josefin Slab", 400, true],
        ["Josefin Slab Light", "Josefin Slab", 300, false],
        ["Josefin Slab Light Italic", "Josefin Slab", 300, true],
        ["Josefin Slab Semi Bold", "Josefin Slab", 600, false],
        ["Josefin Slab Semi Bold Italic", "Josefin Slab", 600, true],
        ["Josefin Slab Thin", "Josefin Slab", 100, false],
        ["Josefin Slab Thin Italic", "Josefin Slab", 100, true],
        ["Joti One", "Joti One", 400, false],
        ["Judson", "Judson", 400, false],
        ["Judson Bold", "Judson", 700, false],
        ["Judson Italic", "Judson", 400, true],
        ["Julee", "Julee", 400, false],
        ["Julius Sans One", "Julius Sans One", 400, false],
        ["Junge", "Junge", 400, false],
        ["Jura", "Jura", 400, false],
        ["Jura Light", "Jura", 300, false],
        ["Jura Medium", "Jura", 500, false],
        ["Jura Semi Bold", "Jura", 600, false],
        ["Just Another Hand", "Just Another Hand", 400, false],
        ["Just Me Again Down Here", "Just Me Again Down Here", 400, false],
        ["Kadwa", "Kadwa", 400, false],
        ["Kadwa Bold", "Kadwa", 700, false],
        ["Kalam", "Kalam", 400, false],
        ["Kalam Bold", "Kalam", 700, false],
        ["Kalam Light", "Kalam", 300, false],
        ["Kameron", "Kameron", 400, false],
        ["Kameron Bold", "Kameron", 700, false],
        ["Kanit", "Kanit", 400, false],
        ["Kanit Black", "Kanit", 900, false],
        ["Kanit Black Italic", "Kanit", 900, true],
        ["Kanit Bold", "Kanit", 700, false],
        ["Kanit Bold Italic", "Kanit", 700, true],
        ["Kanit Extra Bold", "Kanit", 800, false],
        ["Kanit Extra Bold Italic", "Kanit", 800, true],
        ["Kanit Extra Light", "Kanit", 200, false],
        ["Kanit Extra Light Italic", "Kanit", 200, true],
        ["Kanit Italic", "Kanit", 400, true],
        ["Kanit Light", "Kanit", 300, false],
        ["Kanit Light Italic", "Kanit", 300, true],
        ["Kanit Medium", "Kanit", 500, false],
        ["Kanit Medium Italic", "Kanit", 500, true],
        ["Kanit Semi Bold", "Kanit", 600, false],
        ["Kanit Semi Bold Italic", "Kanit", 600, true],
        ["Kanit Thin", "Kanit", 100, false],
        ["Kanit Thin Italic", "Kanit", 100, true],
        ["Kantumruy", "Kantumruy", 400, false],
        ["Kantumruy Bold", "Kantumruy", 700, false],
        ["Kantumruy Light", "Kantumruy", 300, false],
        ["Karla", "Karla", 400, false],
        ["Karla Bold", "Karla", 700, false],
        ["Karla Bold Italic", "Karla", 700, true],
        ["Karla Italic", "Karla", 400, true],
        ["Karma", "Karma", 400, false],
        ["Karma Bold", "Karma", 700, false],
        ["Karma Light", "Karma", 300, false],
        ["Karma Medium", "Karma", 500, false],
        ["Karma Semi Bold", "Karma", 600, false],
        ["Katibeh", "Katibeh", 400, false],
        ["Kaushan Script", "Kaushan Script", 400, false],
        ["Kavivanar", "Kavivanar", 400, false],
        ["Kavoon", "Kavoon", 400, false],
        ["Kdam Thmor", "Kdam Thmor", 400, false],
        ["Keania One", "Keania One", 400, false],
        ["Kelly Slab", "Kelly Slab", 400, false],
        ["Kenia", "Kenia", 400, false],
        ["Khand", "Khand", 400, false],
        ["Khand Bold", "Khand", 700, false],
        ["Khand Light", "Khand", 300, false],
        ["Khand Medium", "Khand", 500, false],
        ["Khand Semi Bold", "Khand", 600, false],
        ["Khmer", "Khmer", 400, false],
        ["Khula", "Khula", 400, false],
        ["Khula Bold", "Khula", 700, false],
        ["Khula Extra Bold", "Khula", 800, false],
        ["Khula Light", "Khula", 300, false],
        ["Khula Semi Bold", "Khula", 600, false],
        ["Kite One", "Kite One", 400, false],
        ["Knewave", "Knewave", 400, false],
        ["Kotta One", "Kotta One", 400, false],
        ["Koulen", "Koulen", 400, false],
        ["Kranky", "Kranky", 400, false],
        ["Kreon", "Kreon", 400, false],
        ["Kreon Bold", "Kreon", 700, false],
        ["Kreon Light", "Kreon", 300, false],
        ["Kristi", "Kristi", 400, false],
        ["Krona One", "Krona One", 400, false],
        ["Kumar One", "Kumar One", 400, false],
        ["Kumar One Outline", "Kumar One Outline", 400, false],
        ["Kurale", "Kurale", 400, false],
        ["La Belle Aurore", "La Belle Aurore", 400, false],
        ["Laila", "Laila", 400, false],
        ["Laila Bold", "Laila", 700, false],
        ["Laila Light", "Laila", 300, false],
        ["Laila Medium", "Laila", 500, false],
        ["Laila Semi Bold", "Laila", 600, false],
        ["Lakki Reddy", "Lakki Reddy", 400, false],
        ["Lalezar", "Lalezar", 400, false],
        ["Lancelot", "Lancelot", 400, false],
        ["Lateef", "Lateef", 400, false],
        ["Lato", "Lato", 400, false],
        ["Lato Black", "Lato", 900, false],
        ["Lato Black Italic", "Lato", 900, true],
        ["Lato Bold", "Lato", 700, false],
        ["Lato Bold Italic", "Lato", 700, true],
        ["Lato Italic", "Lato", 400, true],
        ["Lato Light", "Lato", 300, false],
        ["Lato Light Italic", "Lato", 300, true],
        ["Lato Thin", "Lato", 100, false],
        ["Lato Thin Italic", "Lato", 100, true],
        ["League Script", "League Script", 400, false],
        ["Leckerli One", "Leckerli One", 400, false],
        ["Ledger", "Ledger", 400, false],
        ["Lekton", "Lekton", 400, false],
        ["Lekton Bold", "Lekton", 700, false],
        ["Lekton Italic", "Lekton", 400, true],
        ["Lemon", "Lemon", 400, false],
        ["Lemonada", "Lemonada", 400, false],
        ["Lemonada Bold", "Lemonada", 700, false],
        ["Lemonada Light", "Lemonada", 300, false],
        ["Lemonada Semi Bold", "Lemonada", 600, false],
        ["Libre Baskerville", "Libre Baskerville", 400, false],
        ["Libre Baskerville Bold", "Libre Baskerville", 700, false],
        ["Libre Baskerville Italic", "Libre Baskerville", 400, true],
        ["Libre Franklin", "Libre Franklin", 400, false],
        ["Libre Franklin Black", "Libre Franklin", 900, false],
        ["Libre Franklin Black Italic", "Libre Franklin", 900, true],
        ["Libre Franklin Bold", "Libre Franklin", 700, false],
        ["Libre Franklin Bold Italic", "Libre Franklin", 700, true],
        ["Libre Franklin Extra Bold", "Libre Franklin", 800, false],
        ["Libre Franklin Extra Bold Italic", "Libre Franklin", 800, true],
        ["Libre Franklin Extra Light", "Libre Franklin", 200, false],
        ["Libre Franklin Extra Light Italic", "Libre Franklin", 200, true],
        ["Libre Franklin Italic", "Libre Franklin", 400, true],
        ["Libre Franklin Light", "Libre Franklin", 300, false],
        ["Libre Franklin Light Italic", "Libre Franklin", 300, true],
        ["Libre Franklin Medium", "Libre Franklin", 500, false],
        ["Libre Franklin Medium Italic", "Libre Franklin", 500, true],
        ["Libre Franklin Semi Bold", "Libre Franklin", 600, false],
        ["Libre Franklin Semi Bold Italic", "Libre Franklin", 600, true],
        ["Libre Franklin Thin", "Libre Franklin", 100, false],
        ["Libre Franklin Thin Italic", "Libre Franklin", 100, true],
        ["Life Savers", "Life Savers", 400, false],
        ["Life Savers Bold", "Life Savers", 700, false],
        ["Lilita One", "Lilita One", 400, false],
        ["Lily Script One", "Lily Script One", 400, false],
        ["Limelight", "Limelight", 400, false],
        ["Linden Hill", "Linden Hill", 400, false],
        ["Linden Hill Italic", "Linden Hill", 400, true],
        ["Lobster", "Lobster", 400, false],
        ["Lobster Two", "Lobster Two", 400, false],
        ["Lobster Two Bold", "Lobster Two", 700, false],
        ["Lobster Two Bold Italic", "Lobster Two", 700, true],
        ["Lobster Two Italic", "Lobster Two", 400, true],
        ["Londrina Outline", "Londrina Outline", 400, false],
        ["Londrina Shadow", "Londrina Shadow", 400, false],
        ["Londrina Sketch", "Londrina Sketch", 400, false],
        ["Londrina Solid", "Londrina Solid", 400, false],
        ["Lora", "Lora", 400, false],
        ["Lora Bold", "Lora", 700, false],
        ["Lora Bold Italic", "Lora", 700, true],
        ["Lora Italic", "Lora", 400, true],
        ["Love Ya Like A Sister", "Love Ya Like A Sister", 400, false],
        ["Loved by the King", "Loved by the King", 400, false],
        ["Lovers Quarrel", "Lovers Quarrel", 400, false],
        ["Lucida Grande", "Lucida Grande", 400, false],
        ["Lucida Grande Bold", "Lucida Grande", 700, false],
        ["Lucida Grande Bold Italic", "Lucida Grande", 700, true],
        ["Lucida Grande Italic", "Lucida Grande", 400, true],
        ["Luckiest Guy", "Luckiest Guy", 400, false],
        ["Lusitana", "Lusitana", 400, false],
        ["Lusitana Bold", "Lusitana", 700, false],
        ["Lustria", "Lustria", 400, false],
        ["Macondo", "Macondo", 400, false],
        ["Macondo Swash Caps", "Macondo Swash Caps", 400, false],
        ["Mada", "Mada", 400, false],
        ["Mada Black", "Mada", 900, false],
        ["Mada Light", "Mada", 300, false],
        ["Mada Medium", "Mada", 500, false],
        ["Magra", "Magra", 400, false],
        ["Magra Bold", "Magra", 700, false],
        ["Maiden Orange", "Maiden Orange", 400, false],
        ["Maitree", "Maitree", 400, false],
        ["Maitree Bold", "Maitree", 700, false],
        ["Maitree Extra Light", "Maitree", 200, false],
        ["Maitree Light", "Maitree", 300, false],
        ["Maitree Medium", "Maitree", 500, false],
        ["Maitree Semi Bold", "Maitree", 600, false],
        ["Mako", "Mako", 400, false],
        ["Mallanna", "Mallanna", 400, false],
        ["Mandali", "Mandali", 400, false],
        ["Marcellus", "Marcellus", 400, false],
        ["Marcellus SC", "Marcellus SC", 400, false],
        ["Marck Script", "Marck Script", 400, false],
        ["Margarine", "Margarine", 400, false],
        ["Marko One", "Marko One", 400, false],
        ["Marmelad", "Marmelad", 400, false],
        ["Martel", "Martel", 400, false],
        ["Martel Black", "Martel", 900, false],
        ["Martel Bold", "Martel", 700, false],
        ["Martel Extra Bold", "Martel", 800, false],
        ["Martel Extra Light", "Martel", 200, false],
        ["Martel Light", "Martel", 300, false],
        ["Martel Sans", "Martel Sans", 400, false],
        ["Martel Sans Black", "Martel Sans", 900, false],
        ["Martel Sans Bold", "Martel Sans", 700, false],
        ["Martel Sans Extra Bold", "Martel Sans", 800, false],
        ["Martel Sans Extra Light", "Martel Sans", 200, false],
        ["Martel Sans Light", "Martel Sans", 300, false],
        ["Martel Sans Semi Bold", "Martel Sans", 600, false],
        ["Martel Semi Bold", "Martel", 600, false],
        ["Marvel", "Marvel", 400, false],
        ["Marvel Bold", "Marvel", 700, false],
        ["Marvel Bold Italic", "Marvel", 700, true],
        ["Marvel Italic", "Marvel", 400, true],
        ["Mate", "Mate", 400, false],
        ["Mate Italic", "Mate", 400, true],
        ["Mate SC", "Mate SC", 400, false],
        ["Maven Pro", "Maven Pro", 400, false],
        ["Maven Pro Black", "Maven Pro", 900, false],
        ["Maven Pro Bold", "Maven Pro", 700, false],
        ["Maven Pro Medium", "Maven Pro", 500, false],
        ["McLaren", "McLaren", 400, false],
        ["Meddon", "Meddon", 400, false],
        ["MedievalSharp", "MedievalSharp", 400, false],
        ["Medula One", "Medula One", 400, false],
        ["Meera Inimai", "Meera Inimai", 400, false],
        ["Megrim", "Megrim", 400, false],
        ["Meie Script", "Meie Script", 400, false],
        ["Merienda", "Merienda", 400, false],
        ["Merienda Bold", "Merienda", 700, false],
        ["Merienda One", "Merienda One", 400, false],
        ["Merriweather", "Merriweather", 400, false],
        ["Merriweather Black", "Merriweather", 900, false],
        ["Merriweather Black Italic", "Merriweather", 900, true],
        ["Merriweather Bold", "Merriweather", 700, false],
        ["Merriweather Bold Italic", "Merriweather", 700, true],
        ["Merriweather Italic", "Merriweather", 400, true],
        ["Merriweather Light", "Merriweather", 300, false],
        ["Merriweather Light Italic", "Merriweather", 300, true],
        ["Merriweather Sans", "Merriweather Sans", 400, false],
        ["Merriweather Sans Bold", "Merriweather Sans", 700, false],
        ["Merriweather Sans Bold Italic", "Merriweather Sans", 700, true],
        ["Merriweather Sans Extra Bold", "Merriweather Sans", 800, false],
        ["Merriweather Sans Extra Bold Italic", "Merriweather Sans", 800, true],
        ["Merriweather Sans Italic", "Merriweather Sans", 400, true],
        ["Merriweather Sans Light", "Merriweather Sans", 300, false],
        ["Merriweather Sans Light Italic", "Merriweather Sans", 300, true],
        ["Metal", "Metal", 400, false],
        ["Metal Mania", "Metal Mania", 400, false],
        ["Metamorphous", "Metamorphous", 400, false],
        ["Metrophobic", "Metrophobic", 400, false],
        ["Michroma", "Michroma", 400, false],
        ["Milonga", "Milonga", 400, false],
        ["Miltonian", "Miltonian", 400, false],
        ["Miltonian Tattoo", "Miltonian Tattoo", 400, false],
        ["Miniver", "Miniver", 400, false],
        ["Miriam Libre", "Miriam Libre", 400, false],
        ["Miriam Libre Bold", "Miriam Libre", 700, false],
        ["Mirza", "Mirza", 400, false],
        ["Mirza Bold", "Mirza", 700, false],
        ["Mirza Medium", "Mirza", 500, false],
        ["Mirza Semi Bold", "Mirza", 600, false],
        ["Miss Fajardose", "Miss Fajardose", 400, false],
        ["Mitr", "Mitr", 400, false],
        ["Mitr Bold", "Mitr", 700, false],
        ["Mitr Extra Light", "Mitr", 200, false],
        ["Mitr Light", "Mitr", 300, false],
        ["Mitr Medium", "Mitr", 500, false],
        ["Mitr Semi Bold", "Mitr", 600, false],
        ["Modak", "Modak", 400, false],
        ["Modern Antiqua", "Modern Antiqua", 400, false],
        ["Mogra", "Mogra", 400, false],
        ["Molengo", "Molengo", 400, false],
        ["Molle Italic", "Molle", 400, true],
        ["Monda", "Monda", 400, false],
        ["Monda Bold", "Monda", 700, false],
        ["Monofett", "Monofett", 400, false],
        ["Monoton", "Monoton", 400, false],
        ["Monsieur La Doulaise", "Monsieur La Doulaise", 400, false],
        ["Montaga", "Montaga", 400, false],
        ["Montez", "Montez", 400, false],
        ["Montserrat", "Montserrat", 400, false],
        ["Montserrat Alternates", "Montserrat Alternates", 400, false],
        ["Montserrat Alternates Black", "Montserrat Alternates", 900, false],
        ["Montserrat Alternates Black Italic", "Montserrat Alternates", 900, true],
        ["Montserrat Alternates Bold", "Montserrat Alternates", 700, false],
        ["Montserrat Alternates Bold Italic", "Montserrat Alternates", 700, true],
        ["Montserrat Alternates Extra Bold", "Montserrat Alternates", 800, false],
        ["Montserrat Alternates Extra Bold Italic", "Montserrat Alternates", 800, true],
        ["Montserrat Alternates Extra Light", "Montserrat Alternates", 200, false],
        ["Montserrat Alternates Extra Light Italic", "Montserrat Alternates", 200, true],
        ["Montserrat Alternates Italic", "Montserrat Alternates", 400, true],
        ["Montserrat Alternates Light", "Montserrat Alternates", 300, false],
        ["Montserrat Alternates Light Italic", "Montserrat Alternates", 300, true],
        ["Montserrat Alternates Medium", "Montserrat Alternates", 500, false],
        ["Montserrat Alternates Medium Italic", "Montserrat Alternates", 500, true],
        ["Montserrat Alternates Semi Bold", "Montserrat Alternates", 600, false],
        ["Montserrat Alternates Semi Bold Italic", "Montserrat Alternates", 600, true],
        ["Montserrat Alternates Thin", "Montserrat Alternates", 100, false],
        ["Montserrat Alternates Thin Italic", "Montserrat Alternates", 100, true],
        ["Montserrat Black", "Montserrat", 900, false],
        ["Montserrat Black Italic", "Montserrat", 900, true],
        ["Montserrat Bold", "Montserrat", 700, false],
        ["Montserrat Bold Italic", "Montserrat", 700, true],
        ["Montserrat Extra Bold", "Montserrat", 800, false],
        ["Montserrat Extra Bold Italic", "Montserrat", 800, true],
        ["Montserrat Extra Light", "Montserrat", 200, false],
        ["Montserrat Extra Light Italic", "Montserrat", 200, true],
        ["Montserrat Italic", "Montserrat", 400, true],
        ["Montserrat Light", "Montserrat", 300, false],
        ["Montserrat Light Italic", "Montserrat", 300, true],
        ["Montserrat Medium", "Montserrat", 500, false],
        ["Montserrat Medium Italic", "Montserrat", 500, true],
        ["Montserrat Semi Bold", "Montserrat", 600, false],
        ["Montserrat Semi Bold Italic", "Montserrat", 600, true],
        ["Montserrat Subrayada", "Montserrat Subrayada", 400, false],
        ["Montserrat Subrayada Bold", "Montserrat Subrayada", 700, false],
        ["Montserrat Thin", "Montserrat", 100, false],
        ["Montserrat Thin Italic", "Montserrat", 100, true],
        ["Moul", "Moul", 400, false],
        ["Moulpali", "Moulpali", 400, false],
        ["Mountains of Christmas", "Mountains of Christmas", 400, false],
        ["Mountains of Christmas Bold", "Mountains of Christmas", 700, false],
        ["Mouse Memoirs", "Mouse Memoirs", 400, false],
        ["Mr Bedfort", "Mr Bedfort", 400, false],
        ["Mr Dafoe", "Mr Dafoe", 400, false],
        ["Mr De Haviland", "Mr De Haviland", 400, false],
        ["Mrs Saint Delafield", "Mrs Saint Delafield", 400, false],
        ["Mrs Sheppards", "Mrs Sheppards", 400, false],
        ["Mukta Vaani", "Mukta Vaani", 400, false],
        ["Mukta Vaani Bold", "Mukta Vaani", 700, false],
        ["Mukta Vaani Extra Bold", "Mukta Vaani", 800, false],
        ["Mukta Vaani Extra Light", "Mukta Vaani", 200, false],
        ["Mukta Vaani Light", "Mukta Vaani", 300, false],
        ["Mukta Vaani Medium", "Mukta Vaani", 500, false],
        ["Mukta Vaani Semi Bold", "Mukta Vaani", 600, false],
        ["Muli", "Muli", 400, false],
        ["Muli Black", "Muli", 900, false],
        ["Muli Black Italic", "Muli", 900, true],
        ["Muli Bold", "Muli", 700, false],
        ["Muli Bold Italic", "Muli", 700, true],
        ["Muli Extra Bold", "Muli", 800, false],
        ["Muli Extra Bold Italic", "Muli", 800, true],
        ["Muli Extra Light", "Muli", 200, false],
        ["Muli Extra Light Italic", "Muli", 200, true],
        ["Muli Italic", "Muli", 400, true],
        ["Muli Light", "Muli", 300, false],
        ["Muli Light Italic", "Muli", 300, true],
        ["Muli Semi Bold", "Muli", 600, false],
        ["Muli Semi Bold Italic", "Muli", 600, true],
        ["Mystery Quest", "Mystery Quest", 400, false],
        ["Neucha", "Neucha", 400, false],
        ["Neuton", "Neuton", 400, false],
        ["Neuton Bold", "Neuton", 700, false],
        ["Neuton Extra Bold", "Neuton", 800, false],
        ["Neuton Extra Light", "Neuton", 200, false],
        ["Neuton Italic", "Neuton", 400, true],
        ["Neuton Light", "Neuton", 300, false],
        ["New Rocker", "New Rocker", 400, false],
        ["News Cycle", "News Cycle", 400, false],
        ["News Cycle Bold", "News Cycle", 700, false],
        ["Niconne", "Niconne", 400, false],
        ["Nixie One", "Nixie One", 400, false],
        ["Nobile", "Nobile", 400, false],
        ["Nobile Bold", "Nobile", 700, false],
        ["Nobile Bold Italic", "Nobile", 700, true],
        ["Nobile Italic", "Nobile", 400, true],
        ["Nokora", "Nokora", 400, false],
        ["Nokora Bold", "Nokora", 700, false],
        ["Norican", "Norican", 400, false],
        ["Nosifer", "Nosifer", 400, false],
        ["Nothing You Could Do", "Nothing You Could Do", 400, false],
        ["Noticia Text", "Noticia Text", 400, false],
        ["Noticia Text Bold", "Noticia Text", 700, false],
        ["Noticia Text Bold Italic", "Noticia Text", 700, true],
        ["Noticia Text Italic", "Noticia Text", 400, true],
        ["Noto Sans", "Noto Sans", 400, false],
        ["Noto Sans Bold", "Noto Sans", 700, false],
        ["Noto Sans Bold Italic", "Noto Sans", 700, true],
        ["Noto Sans Italic", "Noto Sans", 400, true],
        ["Noto Serif", "Noto Serif", 400, false],
        ["Noto Serif Bold", "Noto Serif", 700, false],
        ["Noto Serif Bold Italic", "Noto Serif", 700, true],
        ["Noto Serif Italic", "Noto Serif", 400, true],
        ["Nova Cut", "Nova Cut", 400, false],
        ["Nova Flat", "Nova Flat", 400, false],
        ["Nova Mono", "Nova Mono", 400, false],
        ["Nova Oval", "Nova Oval", 400, false],
        ["Nova Round", "Nova Round", 400, false],
        ["Nova Script", "Nova Script", 400, false],
        ["Nova Slim", "Nova Slim", 400, false],
        ["Nova Square", "Nova Square", 400, false],
        ["NTR", "NTR", 400, false],
        ["Numans", "Numans", 400, false],
        ["Nunito", "Nunito", 400, false],
        ["Nunito Black", "Nunito", 900, false],
        ["Nunito Black Italic", "Nunito", 900, true],
        ["Nunito Bold", "Nunito", 700, false],
        ["Nunito Bold Italic", "Nunito", 700, true],
        ["Nunito Extra Bold", "Nunito", 800, false],
        ["Nunito Extra Bold Italic", "Nunito", 800, true],
        ["Nunito Extra Light", "Nunito", 200, false],
        ["Nunito Extra Light Italic", "Nunito", 200, true],
        ["Nunito Italic", "Nunito", 400, true],
        ["Nunito Light", "Nunito", 300, false],
        ["Nunito Light Italic", "Nunito", 300, true],
        ["Nunito Sans", "Nunito Sans", 400, false],
        ["Nunito Sans Black", "Nunito Sans", 900, false],
        ["Nunito Sans Black Italic", "Nunito Sans", 900, true],
        ["Nunito Sans Bold", "Nunito Sans", 700, false],
        ["Nunito Sans Bold Italic", "Nunito Sans", 700, true],
        ["Nunito Sans Extra Bold", "Nunito Sans", 800, false],
        ["Nunito Sans Extra Bold Italic", "Nunito Sans", 800, true],
        ["Nunito Sans Extra Light", "Nunito Sans", 200, false],
        ["Nunito Sans Extra Light Italic", "Nunito Sans", 200, true],
        ["Nunito Sans Italic", "Nunito Sans", 400, true],
        ["Nunito Sans Light", "Nunito Sans", 300, false],
        ["Nunito Sans Light Italic", "Nunito Sans", 300, true],
        ["Nunito Sans Semi Bold", "Nunito Sans", 600, false],
        ["Nunito Sans Semi Bold Italic", "Nunito Sans", 600, true],
        ["Nunito Semi Bold", "Nunito", 600, false],
        ["Nunito Semi Bold Italic", "Nunito", 600, true],
        ["Odor Mean Chey", "Odor Mean Chey", 400, false],
        ["Offside", "Offside", 400, false],
        ["Old Standard TT", "Old Standard TT", 400, false],
        ["Old Standard TT Bold", "Old Standard TT", 700, false],
        ["Old Standard TT Italic", "Old Standard TT", 400, true],
        ["Oldenburg", "Oldenburg", 400, false],
        ["Oleo Script", "Oleo Script", 400, false],
        ["Oleo Script Bold", "Oleo Script", 700, false],
        ["Oleo Script Swash Caps", "Oleo Script Swash Caps", 400, false],
        ["Oleo Script Swash Caps Bold", "Oleo Script Swash Caps", 700, false],
        ["Open Sans", "Open Sans", 400, false],
        ["Open Sans Bold", "Open Sans", 700, false],
        ["Open Sans Bold Italic", "Open Sans", 700, true],
        ["Open Sans Condensed Bold", "Open Sans Condensed", 700, false],
        ["Open Sans Condensed Light", "Open Sans Condensed", 300, false],
        ["Open Sans Condensed Light Italic", "Open Sans Condensed", 300, true],
        ["Open Sans Extra Bold", "Open Sans", 800, false],
        ["Open Sans Extra Bold Italic", "Open Sans", 800, true],
        ["Open Sans Italic", "Open Sans", 400, true],
        ["Open Sans Light", "Open Sans", 300, false],
        ["Open Sans Light Italic", "Open Sans", 300, true],
        ["Open Sans Semi Bold", "Open Sans", 600, false],
        ["Open Sans Semi Bold Italic", "Open Sans", 600, true],
        ["Oranienbaum", "Oranienbaum", 400, false],
        ["Orbitron", "Orbitron", 400, false],
        ["Orbitron Black", "Orbitron", 900, false],
        ["Orbitron Bold", "Orbitron", 700, false],
        ["Orbitron Medium", "Orbitron", 500, false],
        ["Oregano", "Oregano", 400, false],
        ["Oregano Italic", "Oregano", 400, true],
        ["Orienta", "Orienta", 400, false],
        ["Original Surfer", "Original Surfer", 400, false],
        ["Oswald", "Oswald", 400, false],
        ["Oswald Bold", "Oswald", 700, false],
        ["Oswald Extra Light", "Oswald", 200, false],
        ["Oswald Light", "Oswald", 300, false],
        ["Oswald Medium", "Oswald", 500, false],
        ["Oswald Semi Bold", "Oswald", 600, false],
        ["Over the Rainbow", "Over the Rainbow", 400, false],
        ["Overlock", "Overlock", 400, false],
        ["Overlock Black", "Overlock", 900, false],
        ["Overlock Black Italic", "Overlock", 900, true],
        ["Overlock Bold", "Overlock", 700, false],
        ["Overlock Bold Italic", "Overlock", 700, true],
        ["Overlock Italic", "Overlock", 400, true],
        ["Overlock SC", "Overlock SC", 400, false],
        ["Overpass", "Overpass", 400, false],
        ["Overpass Black", "Overpass", 900, false],
        ["Overpass Black Italic", "Overpass", 900, true],
        ["Overpass Bold", "Overpass", 700, false],
        ["Overpass Bold Italic", "Overpass", 700, true],
        ["Overpass Extra Bold", "Overpass", 800, false],
        ["Overpass Extra Bold Italic", "Overpass", 800, true],
        ["Overpass Extra Light", "Overpass", 200, false],
        ["Overpass Extra Light Italic", "Overpass", 200, true],
        ["Overpass Italic", "Overpass", 400, true],
        ["Overpass Light", "Overpass", 300, false],
        ["Overpass Light Italic", "Overpass", 300, true],
        ["Overpass Mono", "Overpass Mono", 400, false],
        ["Overpass Mono Bold", "Overpass Mono", 700, false],
        ["Overpass Mono Light", "Overpass Mono", 300, false],
        ["Overpass Mono Semi Bold", "Overpass Mono", 600, false],
        ["Overpass Semi Bold", "Overpass", 600, false],
        ["Overpass Semi Bold Italic", "Overpass", 600, true],
        ["Overpass Thin", "Overpass", 100, false],
        ["Overpass Thin Italic", "Overpass", 100, true],
        ["Ovo", "Ovo", 400, false],
        ["Oxygen", "Oxygen", 400, false],
        ["Oxygen Bold", "Oxygen", 700, false],
        ["Oxygen Light", "Oxygen", 300, false],
        ["Oxygen Mono", "Oxygen Mono", 400, false],
        ["Pacifico", "Pacifico", 400, false],
        ["Padauk", "Padauk", 400, false],
        ["Padauk Bold", "Padauk", 700, false],
        ["Palanquin", "Palanquin", 400, false],
        ["Palanquin Bold", "Palanquin", 700, false],
        ["Palanquin Dark", "Palanquin Dark", 400, false],
        ["Palanquin Dark Bold", "Palanquin Dark", 700, false],
        ["Palanquin Dark Medium", "Palanquin Dark", 500, false],
        ["Palanquin Dark Semi Bold", "Palanquin Dark", 600, false],
        ["Palanquin Extra Light", "Palanquin", 200, false],
        ["Palanquin Light", "Palanquin", 300, false],
        ["Palanquin Medium", "Palanquin", 500, false],
        ["Palanquin Semi Bold", "Palanquin", 600, false],
        ["Palanquin Thin", "Palanquin", 100, false],
        ["Pangolin", "Pangolin", 400, false],
        ["Paprika", "Paprika", 400, false],
        ["Parisienne", "Parisienne", 400, false],
        ["Passero One", "Passero One", 400, false],
        ["Passion One", "Passion One", 400, false],
        ["Passion One Black", "Passion One", 900, false],
        ["Passion One Bold", "Passion One", 700, false],
        ["Pathway Gothic One", "Pathway Gothic One", 400, false],
        ["Patrick Hand", "Patrick Hand", 400, false],
        ["Patrick Hand SC", "Patrick Hand SC", 400, false],
        ["Pattaya", "Pattaya", 400, false],
        ["Patua One", "Patua One", 400, false],
        ["Pavanam", "Pavanam", 400, false],
        ["Paytone One", "Paytone One", 400, false],
        ["Peddana", "Peddana", 400, false],
        ["Peralta", "Peralta", 400, false],
        ["Permanent Marker", "Permanent Marker", 400, false],
        ["Petit Formal Script", "Petit Formal Script", 400, false],
        ["Petrona", "Petrona", 400, false],
        ["Philosopher", "Philosopher", 400, false],
        ["Philosopher Bold", "Philosopher", 700, false],
        ["Philosopher Bold Italic", "Philosopher", 700, true],
        ["Philosopher Italic", "Philosopher", 400, true],
        ["Piedra", "Piedra", 400, false],
        ["Pinyon Script", "Pinyon Script", 400, false],
        ["Pirata One", "Pirata One", 400, false],
        ["Plaster", "Plaster", 400, false],
        ["Play", "Play", 400, false],
        ["Play Bold", "Play", 700, false],
        ["Playball", "Playball", 400, false],
        ["Playfair Display", "Playfair Display", 400, false],
        ["Playfair Display Black", "Playfair Display", 900, false],
        ["Playfair Display Black Italic", "Playfair Display", 900, true],
        ["Playfair Display Bold", "Playfair Display", 700, false],
        ["Playfair Display Bold Italic", "Playfair Display", 700, true],
        ["Playfair Display Italic", "Playfair Display", 400, true],
        ["Playfair Display SC", "Playfair Display SC", 400, false],
        ["Playfair Display SC Black", "Playfair Display SC", 900, false],
        ["Playfair Display SC Black Italic", "Playfair Display SC", 900, true],
        ["Playfair Display SC Bold", "Playfair Display SC", 700, false],
        ["Playfair Display SC Bold Italic", "Playfair Display SC", 700, true],
        ["Playfair Display SC Italic", "Playfair Display SC", 400, true],
        ["Podkova", "Podkova", 400, false],
        ["Podkova Bold", "Podkova", 700, false],
        ["Podkova Extra Bold", "Podkova", 800, false],
        ["Podkova Medium", "Podkova", 500, false],
        ["Podkova Semi Bold", "Podkova", 600, false],
        ["Poiret One", "Poiret One", 400, false],
        ["Poller One", "Poller One", 400, false],
        ["Poly", "Poly", 400, false],
        ["Poly Italic", "Poly", 400, true],
        ["Pompiere", "Pompiere", 400, false],
        ["Pontano Sans", "Pontano Sans", 400, false],
        ["Poppins", "Poppins", 400, false],
        ["Poppins Bold", "Poppins", 700, false],
        ["Poppins Light", "Poppins", 300, false],
        ["Poppins Medium", "Poppins", 500, false],
        ["Poppins Semi Bold", "Poppins", 600, false],
        ["Port Lligat Sans", "Port Lligat Sans", 400, false],
        ["Port Lligat Slab", "Port Lligat Slab", 400, false],
        ["Pragati Narrow", "Pragati Narrow", 400, false],
        ["Pragati Narrow Bold", "Pragati Narrow", 700, false],
        ["Prata", "Prata", 400, false],
        ["Preahvihear", "Preahvihear", 400, false],
        ["Press Start 2P", "", 400, false],
        ["Pridi", "Pridi", 400, false],
        ["Pridi Bold", "Pridi", 700, false],
        ["Pridi Extra Light", "Pridi", 200, false],
        ["Pridi Light", "Pridi", 300, false],
        ["Pridi Medium", "Pridi", 500, false],
        ["Pridi Semi Bold", "Pridi", 600, false],
        ["Princess Sofia", "Princess Sofia", 400, false],
        ["Prociono", "Prociono", 400, false],
        ["Prompt", "Prompt", 400, false],
        ["Prompt Black", "Prompt", 900, false],
        ["Prompt Black Italic", "Prompt", 900, true],
        ["Prompt Bold", "Prompt", 700, false],
        ["Prompt Bold Italic", "Prompt", 700, true],
        ["Prompt Extra Bold", "Prompt", 800, false],
        ["Prompt Extra Bold Italic", "Prompt", 800, true],
        ["Prompt Extra Light", "Prompt", 200, false],
        ["Prompt Extra Light Italic", "Prompt", 200, true],
        ["Prompt Italic", "Prompt", 400, true],
        ["Prompt Light", "Prompt", 300, false],
        ["Prompt Light Italic", "Prompt", 300, true],
        ["Prompt Medium", "Prompt", 500, false],
        ["Prompt Medium Italic", "Prompt", 500, true],
        ["Prompt Semi Bold", "Prompt", 600, false],
        ["Prompt Semi Bold Italic", "Prompt", 600, true],
        ["Prompt Thin", "Prompt", 100, false],
        ["Prompt Thin Italic", "Prompt", 100, true],
        ["Prosto One", "Prosto One", 400, false],
        ["Proza Libre", "Proza Libre", 400, false],
        ["Proza Libre Bold", "Proza Libre", 700, false],
        ["Proza Libre Bold Italic", "Proza Libre", 700, true],
        ["Proza Libre Extra Bold", "Proza Libre", 800, false],
        ["Proza Libre Extra Bold Italic", "Proza Libre", 800, true],
        ["Proza Libre Italic", "Proza Libre", 400, true],
        ["Proza Libre Medium", "Proza Libre", 500, false],
        ["Proza Libre Medium Italic", "Proza Libre", 500, true],
        ["Proza Libre Semi Bold", "Proza Libre", 600, false],
        ["Proza Libre Semi Bold Italic", "Proza Libre", 600, true],
        ["PT Mono", "PT Mono", 400, false],
        ["PT Sans", "PT Sans", 400, false],
        ["PT Sans Bold", "PT Sans", 700, false],
        ["PT Sans Bold Italic", "PT Sans", 700, true],
        ["PT Sans Caption", "PT Sans Caption", 400, false],
        ["PT Sans Caption Bold", "PT Sans Caption", 700, false],
        ["PT Sans Italic", "PT Sans", 400, true],
        ["PT Sans Narrow", "PT Sans Narrow", 400, false],
        ["PT Sans Narrow Bold", "PT Sans Narrow", 700, false],
        ["PT Serif", "PT Serif", 400, false],
        ["PT Serif Bold", "PT Serif", 700, false],
        ["PT Serif Bold Italic", "PT Serif", 700, true],
        ["PT Serif Caption", "PT Serif Caption", 400, false],
        ["PT Serif Caption Italic", "PT Serif Caption", 400, true],
        ["PT Serif Italic", "PT Serif", 400, true],
        ["Puritan", "Puritan", 400, false],
        ["Puritan Bold", "Puritan", 700, false],
        ["Puritan Bold Italic", "Puritan", 700, true],
        ["Puritan Italic", "Puritan", 400, true],
        ["Purple Purse", "Purple Purse", 400, false],
        ["Quando", "Quando", 400, false],
        ["Quantico", "Quantico", 400, false],
        ["Quantico Bold", "Quantico", 700, false],
        ["Quantico Bold Italic", "Quantico", 700, true],
        ["Quantico Italic", "Quantico", 400, true],
        ["Quattrocento", "Quattrocento", 400, false],
        ["Quattrocento Bold", "Quattrocento", 700, false],
        ["Quattrocento Sans", "Quattrocento Sans", 400, false],
        ["Quattrocento Sans Bold", "Quattrocento Sans", 700, false],
        ["Quattrocento Sans Bold Italic", "Quattrocento Sans", 700, true],
        ["Quattrocento Sans Italic", "Quattrocento Sans", 400, true],
        ["Questrial", "Questrial", 400, false],
        ["Quicksand", "Quicksand", 400, false],
        ["Quicksand Bold", "Quicksand", 700, false],
        ["Quicksand Light", "Quicksand", 300, false],
        ["Quicksand Medium", "Quicksand", 500, false],
        ["Quintessential", "Quintessential", 400, false],
        ["Qwigley", "Qwigley", 400, false],
        ["Racing Sans One", "Racing Sans One", 400, false],
        ["Radley", "Radley", 400, false],
        ["Radley Italic", "Radley", 400, true],
        ["Rajdhani", "Rajdhani", 400, false],
        ["Rajdhani Bold", "Rajdhani", 700, false],
        ["Rajdhani Light", "Rajdhani", 300, false],
        ["Rajdhani Medium", "Rajdhani", 500, false],
        ["Rajdhani Semi Bold", "Rajdhani", 600, false],
        ["Rakkas", "Rakkas", 400, false],
        ["Raleway", "Raleway", 400, false],
        ["Raleway Black", "Raleway", 900, false],
        ["Raleway Black Italic", "Raleway", 900, true],
        ["Raleway Bold", "Raleway", 700, false],
        ["Raleway Bold Italic", "Raleway", 700, true],
        ["Raleway Dots", "Raleway Dots", 400, false],
        ["Raleway Extra Bold", "Raleway", 800, false],
        ["Raleway Extra Bold Italic", "Raleway", 800, true],
        ["Raleway Extra Light", "Raleway", 200, false],
        ["Raleway Extra Light Italic", "Raleway", 200, true],
        ["Raleway Italic", "Raleway", 400, true],
        ["Raleway Light", "Raleway", 300, false],
        ["Raleway Light Italic", "Raleway", 300, true],
        ["Raleway Medium", "Raleway", 500, false],
        ["Raleway Medium Italic", "Raleway", 500, true],
        ["Raleway Semi Bold", "Raleway", 600, false],
        ["Raleway Semi Bold Italic", "Raleway", 600, true],
        ["Raleway Thin", "Raleway", 100, false],
        ["Raleway Thin Italic", "Raleway", 100, true],
        ["Ramabhadra", "Ramabhadra", 400, false],
        ["Ramaraja", "Ramaraja", 400, false],
        ["Rambla", "Rambla", 400, false],
        ["Rambla Bold", "Rambla", 700, false],
        ["Rambla Bold Italic", "Rambla", 700, true],
        ["Rambla Italic", "Rambla", 400, true],
        ["Rammetto One", "Rammetto One", 400, false],
        ["Ranchers", "Ranchers", 400, false],
        ["Rancho", "Rancho", 400, false],
        ["Ranga", "Ranga", 400, false],
        ["Ranga Bold", "Ranga", 700, false],
        ["Rasa", "Rasa", 400, false],
        ["Rasa Bold", "Rasa", 700, false],
        ["Rasa Light", "Rasa", 300, false],
        ["Rasa Medium", "Rasa", 500, false],
        ["Rasa Semi Bold", "Rasa", 600, false],
        ["Rationale", "Rationale", 400, false],
        ["Ravi Prakash", "Ravi Prakash", 400, false],
        ["Redressed", "Redressed", 400, false],
        ["Reem Kufi", "Reem Kufi", 400, false],
        ["Reenie Beanie", "Reenie Beanie", 400, false],
        ["Revalia", "Revalia", 400, false],
        ["Rhodium Libre", "Rhodium Libre", 400, false],
        ["Ribeye", "Ribeye", 400, false],
        ["Ribeye Marrow", "Ribeye Marrow", 400, false],
        ["Righteous", "Righteous", 400, false],
        ["Risque", "Risque", 400, false],
        ["Roboto", "Roboto", 400, false],
        ["Roboto Black", "Roboto", 900, false],
        ["Roboto Black Italic", "Roboto", 900, true],
        ["Roboto Bold", "Roboto", 700, false],
        ["Roboto Bold Italic", "Roboto", 700, true],
        ["Roboto Condensed", "Roboto Condensed", 400, false],
        ["Roboto Condensed Bold", "Roboto Condensed", 700, false],
        ["Roboto Condensed Bold Italic", "Roboto Condensed", 700, true],
        ["Roboto Condensed Italic", "Roboto Condensed", 400, true],
        ["Roboto Condensed Light", "Roboto Condensed", 300, false],
        ["Roboto Condensed Light Italic", "Roboto Condensed", 300, true],
        ["Roboto Italic", "Roboto", 400, true],
        ["Roboto Light", "Roboto", 300, false],
        ["Roboto Light Italic", "Roboto", 300, true],
        ["Roboto Medium", "Roboto", 500, false],
        ["Roboto Medium Italic", "Roboto", 500, true],
        ["Roboto Mono", "Roboto Mono", 400, false],
        ["Roboto Mono Bold", "Roboto Mono", 700, false],
        ["Roboto Mono Bold Italic", "Roboto Mono", 700, true],
        ["Roboto Mono Italic", "Roboto Mono", 400, true],
        ["Roboto Mono Light", "Roboto Mono", 300, false],
        ["Roboto Mono Light Italic", "Roboto Mono", 300, true],
        ["Roboto Mono Medium", "Roboto Mono", 500, false],
        ["Roboto Mono Medium Italic", "Roboto Mono", 500, true],
        ["Roboto Mono Thin", "Roboto Mono", 100, false],
        ["Roboto Mono Thin Italic", "Roboto Mono", 100, true],
        ["Roboto Slab", "Roboto Slab", 400, false],
        ["Roboto Slab Bold", "Roboto Slab", 700, false],
        ["Roboto Slab Light", "Roboto Slab", 300, false],
        ["Roboto Slab Thin", "Roboto Slab", 100, false],
        ["Roboto Thin", "Roboto", 100, false],
        ["Roboto Thin Italic", "Roboto", 100, true],
        ["Rochester", "Rochester", 400, false],
        ["Rock Salt", "Rock Salt", 400, false],
        ["Rokkitt", "Rokkitt", 400, false],
        ["Rokkitt Black", "Rokkitt", 900, false],
        ["Rokkitt Bold", "Rokkitt", 700, false],
        ["Rokkitt Extra Bold", "Rokkitt", 800, false],
        ["Rokkitt Extra Light", "Rokkitt", 200, false],
        ["Rokkitt Light", "Rokkitt", 300, false],
        ["Rokkitt Medium", "Rokkitt", 500, false],
        ["Rokkitt Semi Bold", "Rokkitt", 600, false],
        ["Rokkitt Thin", "Rokkitt", 100, false],
        ["Romanesco", "Romanesco", 400, false],
        ["Ropa Sans", "Ropa Sans", 400, false],
        ["Ropa Sans Italic", "Ropa Sans", 400, true],
        ["Rosario", "Rosario", 400, false],
        ["Rosario Bold", "Rosario", 700, false],
        ["Rosario Bold Italic", "Rosario", 700, true],
        ["Rosario Italic", "Rosario", 400, true],
        ["Rosarivo", "Rosarivo", 400, false],
        ["Rosarivo Italic", "Rosarivo", 400, true],
        ["Rouge Script", "Rouge Script", 400, false],
        ["Rozha One", "Rozha One", 400, false],
        ["Rubik", "Rubik", 400, false],
        ["Rubik Black", "Rubik", 900, false],
        ["Rubik Black Italic", "Rubik", 900, true],
        ["Rubik Bold", "Rubik", 700, false],
        ["Rubik Bold Italic", "Rubik", 700, true],
        ["Rubik Italic", "Rubik", 400, true],
        ["Rubik Light", "Rubik", 300, false],
        ["Rubik Light Italic", "Rubik", 300, true],
        ["Rubik Medium", "Rubik", 500, false],
        ["Rubik Medium Italic", "Rubik", 500, true],
        ["Rubik Mono One", "Rubik Mono One", 400, false],
        ["Ruda", "Ruda", 400, false],
        ["Ruda Black", "Ruda", 900, false],
        ["Ruda Bold", "Ruda", 700, false],
        ["Rufina", "Rufina", 400, false],
        ["Rufina Bold", "Rufina", 700, false],
        ["Ruge Boogie", "Ruge Boogie", 400, false],
        ["Ruluko", "Ruluko", 400, false],
        ["Rum Raisin", "Rum Raisin", 400, false],
        ["Ruslan Display", "Ruslan Display", 400, false],
        ["Russo One", "Russo One", 400, false],
        ["Ruthie", "Ruthie", 400, false],
        ["Rye", "Rye", 400, false],
        ["Sacramento", "Sacramento", 400, false],
        ["Sahitya", "Sahitya", 400, false],
        ["Sahitya Bold", "Sahitya", 700, false],
        ["Sail", "Sail", 400, false],
        ["Salsa", "Salsa", 400, false],
        ["Sanchez", "Sanchez", 400, false],
        ["Sanchez Italic", "Sanchez", 400, true],
        ["Sancreek", "Sancreek", 400, false],
        ["Sansita", "Sansita", 400, false],
        ["Sansita Black", "Sansita", 900, false],
        ["Sansita Black Italic", "Sansita", 900, true],
        ["Sansita Bold", "Sansita", 700, false],
        ["Sansita Bold Italic", "Sansita", 700, true],
        ["Sansita Extra Bold", "Sansita", 800, false],
        ["Sansita Extra Bold Italic", "Sansita", 800, true],
        ["Sansita Italic", "Sansita", 400, true],
        ["Sarala", "Sarala", 400, false],
        ["Sarala Bold", "Sarala", 700, false],
        ["Sarina", "Sarina", 400, false],
        ["Sarpanch", "Sarpanch", 400, false],
        ["Sarpanch Black", "Sarpanch", 900, false],
        ["Sarpanch Bold", "Sarpanch", 700, false],
        ["Sarpanch Extra Bold", "Sarpanch", 800, false],
        ["Sarpanch Medium", "Sarpanch", 500, false],
        ["Sarpanch Semi Bold", "Sarpanch", 600, false],
        ["Satisfy", "Satisfy", 400, false],
        ["Scada", "Scada", 400, false],
        ["Scada Bold", "Scada", 700, false],
        ["Scada Bold Italic", "Scada", 700, true],
        ["Scada Italic", "Scada", 400, true],
        ["Scheherazade", "Scheherazade", 400, false],
        ["Scheherazade Bold", "Scheherazade", 700, false],
        ["Schoolbell", "Schoolbell", 400, false],
        ["Scope One", "Scope One", 400, false],
        ["Seaweed Script", "Seaweed Script", 400, false],
        ["Secular One", "Secular One", 400, false],
        ["Sevillana", "Sevillana", 400, false],
        ["Seymour One", "Seymour One", 400, false],
        ["Shadows Into Light", "Shadows Into Light", 400, false],
        ["Shadows Into Light Two", "Shadows Into Light Two", 400, false],
        ["Shanti", "Shanti", 400, false],
        ["Share", "Share", 400, false],
        ["Share Bold", "Share", 700, false],
        ["Share Bold Italic", "Share", 700, true],
        ["Share Italic", "Share", 400, true],
        ["Share Tech", "Share Tech", 400, false],
        ["Share Tech Mono", "Share Tech Mono", 400, false],
        ["Shojumaru", "Shojumaru", 400, false],
        ["Short Stack", "Short Stack", 400, false],
        ["Shrikhand", "Shrikhand", 400, false],
        ["Siemreap", "Siemreap", 400, false],
        ["Sigmar One", "Sigmar One", 400, false],
        ["Signika", "Signika", 400, false],
        ["Signika Bold", "Signika", 700, false],
        ["Signika Light", "Signika", 300, false],
        ["Signika Negative", "Signika Negative", 400, false],
        ["Signika Negative Bold", "Signika Negative", 700, false],
        ["Signika Negative Light", "Signika Negative", 300, false],
        ["Signika Negative Semi Bold", "Signika Negative", 600, false],
        ["Signika Semi Bold", "Signika", 600, false],
        ["Simonetta", "Simonetta", 400, false],
        ["Simonetta Black", "Simonetta", 900, false],
        ["Simonetta Black Italic", "Simonetta", 900, true],
        ["Simonetta Italic", "Simonetta", 400, true],
        ["Sintony", "Sintony", 400, false],
        ["Sintony Bold", "Sintony", 700, false],
        ["Sirin Stencil", "Sirin Stencil", 400, false],
        ["Six Caps", "Six Caps", 400, false],
        ["Skranji", "Skranji", 400, false],
        ["Skranji Bold", "Skranji", 700, false],
        ["Slabo 13px", "", 400, false],
        ["Slabo 27px", "", 400, false],
        ["Slackey", "Slackey", 400, false],
        ["Smokum", "Smokum", 400, false],
        ["Smythe", "Smythe", 400, false],
        ["Sniglet", "Sniglet", 400, false],
        ["Sniglet Extra Bold", "Sniglet", 800, false],
        ["Snippet", "Snippet", 400, false],
        ["Snowburst One", "Snowburst One", 400, false],
        ["Sofadi One", "Sofadi One", 400, false],
        ["Sofia", "Sofia", 400, false],
        ["Sonsie One", "Sonsie One", 400, false],
        ["Sorts Mill Goudy", "Sorts Mill Goudy", 400, false],
        ["Sorts Mill Goudy Italic", "Sorts Mill Goudy", 400, true],
        ["Source Code Pro", "Source Code Pro", 400, false],
        ["Source Code Pro Black", "Source Code Pro", 900, false],
        ["Source Code Pro Bold", "Source Code Pro", 700, false],
        ["Source Code Pro Extra Light", "Source Code Pro", 200, false],
        ["Source Code Pro Light", "Source Code Pro", 300, false],
        ["Source Code Pro Medium", "Source Code Pro", 500, false],
        ["Source Code Pro Semi Bold", "Source Code Pro", 600, false],
        ["Source Sans 3", "", 400, false],
        ["Source Sans 3 Black", "", 900, false],
        ["Source Sans 3 Black Italic", "", 900, true],
        ["Source Sans 3 Bold", "", 700, false],
        ["Source Sans 3 Bold Italic", "", 700, true],
        ["Source Sans 3 Extra Light", "", 200, false],
        ["Source Sans 3 Extra Light Italic", "", 200, true],
        ["Source Sans 3 Italic", "", 400, true],
        ["Source Sans 3 Light", "", 300, false],
        ["Source Sans 3 Light Italic", "", 300, true],
        ["Source Sans 3 Semi Bold", "", 600, false],
        ["Source Sans 3 Semi Bold Italic", "", 600, true],
        ["Source Serif Pro", "Source Serif Pro", 400, false],
        ["Source Serif Pro Bold", "Source Serif Pro", 700, false],
        ["Source Serif Pro Semi Bold", "Source Serif Pro", 600, false],
        ["Space Mono", "Space Mono", 400, false],
        ["Space Mono Bold", "Space Mono", 700, false],
        ["Space Mono Bold Italic", "Space Mono", 700, true],
        ["Space Mono Italic", "Space Mono", 400, true],
        ["Special Elite", "Special Elite", 400, false],
        ["Spicy Rice", "Spicy Rice", 400, false],
        ["Spinnaker", "Spinnaker", 400, false],
        ["Spirax", "Spirax", 400, false],
        ["Squada One", "Squada One", 400, false],
        ["Sree Krushnadevaraya", "Sree Krushnadevaraya", 400, false],
        ["Sriracha", "Sriracha", 400, false],
        ["Stalemate", "Stalemate", 400, false],
        ["Stalinist One", "Stalinist One", 400, false],
        ["Stardos Stencil", "Stardos Stencil", 400, false],
        ["Stardos Stencil Bold", "Stardos Stencil", 700, false],
        ["Stint Ultra Condensed", "Stint Ultra Condensed", 400, false],
        ["Stint Ultra Expanded", "Stint Ultra Expanded", 400, false],
        ["Stoke", "Stoke", 400, false],
        ["Stoke Light", "Stoke", 300, false],
        ["Strait", "Strait", 400, false],
        ["Sue Ellen Francisco", "Sue Ellen Francisco", 400, false],
        ["Suez One", "Suez One", 400, false],
        ["Sumana", "Sumana", 400, false],
        ["Sumana Bold", "Sumana", 700, false],
        ["Sunshiney", "Sunshiney", 400, false],
        ["Supermercado One", "Supermercado One", 400, false],
        ["Sura", "Sura", 400, false],
        ["Sura Bold", "Sura", 700, false],
        ["Suranna", "Suranna", 400, false],
        ["Suravaram", "Suravaram", 400, false],
        ["Suwannaphum", "Suwannaphum", 400, false],
        ["Swanky and Moo Moo", "Swanky and Moo Moo", 400, false],
        ["Syncopate", "Syncopate", 400, false],
        ["Syncopate Bold", "Syncopate", 700, false],
        ["Tahoma", "Tahoma", 400, false],
        ["Tahoma Bold", "Tahoma", 700, false],
        ["Tahoma Bold Italic", "Tahoma", 700, true],
        ["Tahoma Italic", "Tahoma", 400, true],
        ["Tangerine", "Tangerine", 400, false],
        ["Tangerine Bold", "Tangerine", 700, false],
        ["Taprom", "Taprom", 400, false],
        ["Tauri", "Tauri", 400, false],
        ["Taviraj", "Taviraj", 400, false],
        ["Taviraj Black", "Taviraj", 900, false],
        ["Taviraj Black Italic", "Taviraj", 900, true],
        ["Taviraj Bold", "Taviraj", 700, false],
        ["Taviraj Bold Italic", "Taviraj", 700, true],
        ["Taviraj Extra Bold", "Taviraj", 800, false],
        ["Taviraj Extra Bold Italic", "Taviraj", 800, true],
        ["Taviraj Extra Light", "Taviraj", 200, false],
        ["Taviraj Extra Light Italic", "Taviraj", 200, true],
        ["Taviraj Italic", "Taviraj", 400, true],
        ["Taviraj Light", "Taviraj", 300, false],
        ["Taviraj Light Italic", "Taviraj", 300, true],
        ["Taviraj Medium", "Taviraj", 500, false],
        ["Taviraj Medium Italic", "Taviraj", 500, true],
        ["Taviraj Semi Bold", "Taviraj", 600, false],
        ["Taviraj Semi Bold Italic", "Taviraj", 600, true],
        ["Taviraj Thin", "Taviraj", 100, false],
        ["Taviraj Thin Italic", "Taviraj", 100, true],
        ["Teko", "Teko", 400, false],
        ["Teko Bold", "Teko", 700, false],
        ["Teko Light", "Teko", 300, false],
        ["Teko Medium", "Teko", 500, false],
        ["Teko Semi Bold", "Teko", 600, false],
        ["Telex", "Telex", 400, false],
        ["Tenali Ramakrishna", "Tenali Ramakrishna", 400, false],
        ["Tenor Sans", "Tenor Sans", 400, false],
        ["Text Me One", "Text Me One", 400, false],
        ["The Girl Next Door", "The Girl Next Door", 400, false],
        ["Tienne", "Tienne", 400, false],
        ["Tienne Black", "Tienne", 900, false],
        ["Tienne Bold", "Tienne", 700, false],
        ["Tillana", "Tillana", 400, false],
        ["Tillana Bold", "Tillana", 700, false],
        ["Tillana Extra Bold", "Tillana", 800, false],
        ["Tillana Medium", "Tillana", 500, false],
        ["Tillana Semi Bold", "Tillana", 600, false],
        ["Times New Roman", "Times New Roman", 400, false],
        ["Times New Roman Bold", "Times New Roman", 700, false],
        ["Times New Roman Bold Italic", "Times New Roman", 700, true],
        ["Times New Roman Italic", "Times New Roman", 400, true],
        ["Timmana", "Timmana", 400, false],
        ["Tinos", "Tinos", 400, false],
        ["Tinos Bold", "Tinos", 700, false],
        ["Tinos Bold Italic", "Tinos", 700, true],
        ["Tinos Italic", "Tinos", 400, true],
        ["Titan One", "Titan One", 400, false],
        ["Titillium Web", "Titillium Web", 400, false],
        ["Titillium Web Black", "Titillium Web", 900, false],
        ["Titillium Web Bold", "Titillium Web", 700, false],
        ["Titillium Web Bold Italic", "Titillium Web", 700, true],
        ["Titillium Web Extra Light", "Titillium Web", 200, false],
        ["Titillium Web Extra Light Italic", "Titillium Web", 200, true],
        ["Titillium Web Italic", "Titillium Web", 400, true],
        ["Titillium Web Light", "Titillium Web", 300, false],
        ["Titillium Web Light Italic", "Titillium Web", 300, true],
        ["Titillium Web Semi Bold", "Titillium Web", 600, false],
        ["Titillium Web Semi Bold Italic", "Titillium Web", 600, true],
        ["Trade Winds", "Trade Winds", 400, false],
        ["Trebuchet MS", "Trebuchet MS", 400, false],
        ["Trebuchet MS Bold", "Trebuchet MS", 700, false],
        ["Trebuchet MS Bold Italic", "Trebuchet MS", 700, true],
        ["Trebuchet MS Italic", "Trebuchet MS", 400, true],
        ["Trirong", "Trirong", 400, false],
        ["Trirong Black", "Trirong", 900, false],
        ["Trirong Black Italic", "Trirong", 900, true],
        ["Trirong Bold", "Trirong", 700, false],
        ["Trirong Bold Italic", "Trirong", 700, true],
        ["Trirong Extra Bold", "Trirong", 800, false],
        ["Trirong Extra Bold Italic", "Trirong", 800, true],
        ["Trirong Extra Light", "Trirong", 200, false],
        ["Trirong Extra Light Italic", "Trirong", 200, true],
        ["Trirong Italic", "Trirong", 400, true],
        ["Trirong Light", "Trirong", 300, false],
        ["Trirong Light Italic", "Trirong", 300, true],
        ["Trirong Medium", "Trirong", 500, false],
        ["Trirong Medium Italic", "Trirong", 500, true],
        ["Trirong Semi Bold", "Trirong", 600, false],
        ["Trirong Semi Bold Italic", "Trirong", 600, true],
        ["Trirong Thin", "Trirong", 100, false],
        ["Trirong Thin Italic", "Trirong", 100, true],
        ["Trocchi", "Trocchi", 400, false],
        ["Trochut", "Trochut", 400, false],
        ["Trochut Bold", "Trochut", 700, false],
        ["Trochut Italic", "Trochut", 400, true],
        ["Trykker", "Trykker", 400, false],
        ["Tulpen One", "Tulpen One", 400, false],
        ["Ubuntu", "Ubuntu", 400, false],
        ["Ubuntu Bold", "Ubuntu", 700, false],
        ["Ubuntu Bold Italic", "Ubuntu", 700, true],
        ["Ubuntu Condensed", "Ubuntu Condensed", 400, false],
        ["Ubuntu Italic", "Ubuntu", 400, true],
        ["Ubuntu Light", "Ubuntu", 300, false],
        ["Ubuntu Light Italic", "Ubuntu", 300, true],
        ["Ubuntu Medium", "Ubuntu", 500, false],
        ["Ubuntu Medium Italic", "Ubuntu", 500, true],
        ["Ubuntu Mono", "Ubuntu Mono", 400, false],
        ["Ubuntu Mono Bold", "Ubuntu Mono", 700, false],
        ["Ubuntu Mono Bold Italic", "Ubuntu Mono", 700, true],
        ["Ubuntu Mono Italic", "Ubuntu Mono", 400, true],
        ["Ultra", "Ultra", 400, false],
        ["Uncial Antiqua", "Uncial Antiqua", 400, false],
        ["Underdog", "Underdog", 400, false],
        ["Unica One", "Unica One", 400, false],
        ["UnifrakturCook Bold", "UnifrakturCook", 700, false],
        ["UnifrakturMaguntia", "UnifrakturMaguntia", 400, false],
        ["Unkempt", "Unkempt", 400, false],
        ["Unkempt Bold", "Unkempt", 700, false],
        ["Unlock", "Unlock", 400, false],
        ["Unna", "Unna", 400, false],
        ["Unna Bold", "Unna", 700, false],
        ["Unna Bold Italic", "Unna", 700, true],
        ["Unna Italic", "Unna", 400, true],
        ["Vampiro One", "Vampiro One", 400, false],
        ["Varela", "Varela", 400, false],
        ["Varela Round", "Varela Round", 400, false],
        ["Vast Shadow", "Vast Shadow", 400, false],
        ["Verdana", "Verdana", 400, false],
        ["Verdana Bold", "Verdana", 700, false],
        ["Verdana Bold Italic", "Verdana", 700, true],
        ["Verdana Italic", "Verdana", 400, true],
        ["Vesper Libre", "Vesper Libre", 400, false],
        ["Vesper Libre Black", "Vesper Libre", 900, false],
        ["Vesper Libre Bold", "Vesper Libre", 700, false],
        ["Vesper Libre Medium", "Vesper Libre", 500, false],
        ["Vibur", "Vibur", 400, false],
        ["Vidaloka", "Vidaloka", 400, false],
        ["Viga", "Viga", 400, false],
        ["Voces", "Voces", 400, false],
        ["Volkhov", "Volkhov", 400, false],
        ["Volkhov Bold", "Volkhov", 700, false],
        ["Volkhov Bold Italic", "Volkhov", 700, true],
        ["Volkhov Italic", "Volkhov", 400, true],
        ["Vollkorn", "Vollkorn", 400, false],
        ["Vollkorn Bold", "Vollkorn", 700, false],
        ["Vollkorn Bold Italic", "Vollkorn", 700, true],
        ["Vollkorn Italic", "Vollkorn", 400, true],
        ["Voltaire", "Voltaire", 400, false],
        ["VT323", "VT323", 400, false],
        ["Waiting for the Sunrise", "Waiting for the Sunrise", 400, false],
        ["Wallpoet", "Wallpoet", 400, false],
        ["Walter Turncoat", "Walter Turncoat", 400, false],
        ["Warnes", "Warnes", 400, false],
        ["Wellfleet", "Wellfleet", 400, false],
        ["Wendy One", "Wendy One", 400, false],
        ["Wire One", "Wire One", 400, false],
        ["Work Sans", "Work Sans", 400, false],
        ["Work Sans Black", "Work Sans", 900, false],
        ["Work Sans Bold", "Work Sans", 700, false],
        ["Work Sans Extra Bold", "Work Sans", 800, false],
        ["Work Sans Extra Light", "Work Sans", 200, false],
        ["Work Sans Light", "Work Sans", 300, false],
        ["Work Sans Medium", "Work Sans", 500, false],
        ["Work Sans Semi Bold", "Work Sans", 600, false],
        ["Work Sans Thin", "Work Sans", 100, false],
        ["Yanone Kaffeesatz", "Yanone Kaffeesatz", 400, false],
        ["Yanone Kaffeesatz Bold", "Yanone Kaffeesatz", 700, false],
        ["Yanone Kaffeesatz Extra Light", "Yanone Kaffeesatz", 200, false],
        ["Yanone Kaffeesatz Light", "Yanone Kaffeesatz", 300, false],
        ["Yantramanav", "Yantramanav", 400, false],
        ["Yantramanav Black", "Yantramanav", 900, false],
        ["Yantramanav Bold", "Yantramanav", 700, false],
        ["Yantramanav Light", "Yantramanav", 300, false],
        ["Yantramanav Medium", "Yantramanav", 500, false],
        ["Yantramanav Thin", "Yantramanav", 100, false],
        ["Yatra One", "Yatra One", 400, false],
        ["Yellowtail", "Yellowtail", 400, false],
        ["Yeseva One", "Yeseva One", 400, false],
        ["Yesteryear", "Yesteryear", 400, false],
        ["Yrsa", "Yrsa", 400, false],
        ["Yrsa Bold", "Yrsa", 700, false],
        ["Yrsa Light", "Yrsa", 300, false],
        ["Yrsa Medium", "Yrsa", 500, false],
        ["Yrsa Semi Bold", "Yrsa", 600, false],
        ["Zeyada", "Zeyada", 400, false]
      ];
    }
  });

  // node_modules/@capiro/shared/dist/newsletter-fonts.js
  var require_newsletter_fonts = __commonJS({
    "node_modules/@capiro/shared/dist/newsletter-fonts.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.NEWSLETTER_FONT_CATALOG = void 0;
      exports.newsletterCatalogFont = newsletterCatalogFont;
      exports.newsletterCatalogStyle = newsletterCatalogStyle;
      exports.newsletterWebFontUrls = newsletterWebFontUrls;
      exports.newsletterDesignFontRequests = newsletterDesignFontRequests;
      var newsletter_fonts_catalog_js_1 = require_newsletter_fonts_catalog();
      exports.NEWSLETTER_FONT_CATALOG = [
        ...newsletter_fonts_catalog_js_1.NEWSLETTER_FONT_RECORDS.map(([label, family, weight, italic]) => ({
          label,
          family,
          weight,
          italic
        })),
        { label: "DM Sans", family: "DM Sans", weight: 400, italic: false },
        { label: "Instrument Serif", family: "Instrument Serif", weight: 400, italic: false }
      ];
      var byLabel = new Map(exports.NEWSLETTER_FONT_CATALOG.map((font) => [font.label.toLowerCase(), font]));
      var byFamily = /* @__PURE__ */ new Map();
      for (const font of exports.NEWSLETTER_FONT_CATALOG) {
        const key = font.family.toLowerCase(), current = byFamily.get(key);
        if (!current || font.weight === 400 && !font.italic)
          byFamily.set(key, font);
      }
      function newsletterCatalogFont(value) {
        const label = value.split(",")[0].trim().replace(/^['"]|['"]$/g, "").toLowerCase();
        return byLabel.get(label) ?? byFamily.get(label);
      }
      function newsletterCatalogStyle(value) {
        const font = newsletterCatalogFont(value);
        return font ? {
          fontFamily: `'${font.family}', Arial, sans-serif`,
          fontWeight: font.weight,
          fontStyle: font.italic ? "italic" : "normal"
        } : void 0;
      }
      var systemFonts = new Set([
        "Arial",
        "Arial Black",
        "Comic Sans MS",
        "Courier",
        "Courier New",
        "Georgia",
        "Helvetica",
        "Impact",
        "Lucida Console",
        "Lucida Grande",
        "Lucida Sans Unicode",
        "Palatino Linotype",
        "Tahoma",
        "Times New Roman",
        "Trebuchet MS",
        "Verdana"
      ].map((name) => name.toLowerCase()));
      function newsletterWebFontUrls(requests) {
        const groups = /* @__PURE__ */ new Map();
        for (const request of requests) {
          const font = newsletterCatalogFont(request.value);
          if (!font || systemFonts.has(font.family.toLowerCase()))
            continue;
          const requestedWeight = request.weight ?? (request.bold === void 0 ? font.weight : request.bold ? 700 : 400);
          const requestedItalic = request.italic ?? font.italic;
          const variants = exports.NEWSLETTER_FONT_CATALOG.filter((item) => item.family === font.family);
          const face = variants.find((item) => item.weight === requestedWeight && item.italic === requestedItalic) ?? font;
          const group = groups.get(font.family) ?? /* @__PURE__ */ new Set();
          group.add(`${face.italic ? 1 : 0},${face.weight}`);
          groups.set(font.family, group);
        }
        return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([family, faces]) => {
          const pairs = [...faces].sort((a, b) => {
            const [ai, aw] = a.split(",").map(Number), [bi, bw] = b.split(",").map(Number);
            return ai - bi || aw - bw;
          });
          const italic = pairs.some((pair) => pair.startsWith("1,"));
          const styles = italic ? pairs.join(";") : pairs.map((pair) => pair.split(",")[1]).join(";");
          return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:${italic ? "ital,wght" : "wght"}@${styles}&display=swap`;
        });
      }
      function newsletterDesignFontRequests(design) {
        const requests = [];
        const style = (value) => {
          if (value.fontFamily)
            requests.push({
              value: value.fontFamily,
              bold: value.bold,
              italic: value.italic,
              weight: value.fontWeight
            });
        };
        const html = (markup) => {
          for (const match of markup.matchAll(/\bstyle="([^"]*)"/gi)) {
            const css = match[1].replace(/&quot;/g, '"').replace(/&#(?:39|x27);/gi, "'");
            const family = /(?:^|;)\s*font-family\s*:\s*([^;]+)/i.exec(css)?.[1];
            if (!family)
              continue;
            const weight = /(?:^|;)\s*font-weight\s*:\s*(\d+|bold|normal)/i.exec(css)?.[1];
            const italic = /(?:^|;)\s*font-style\s*:\s*(italic|normal)/i.exec(css)?.[1];
            requests.push({
              value: family,
              ...weight ? { weight: weight === "bold" ? 700 : weight === "normal" ? 400 : Number(weight) } : {},
              ...italic ? { italic: italic === "italic" } : {}
            });
          }
        };
        for (const value of Object.values(design.styles)) {
          if (value && typeof value === "object") {
            if ("fontFamily" in value)
              style(value);
            else
              for (const nested of Object.values(value))
                if (nested && typeof nested === "object")
                  style(nested);
          }
        }
        const blocks = (items) => {
          for (const block of items) {
            style(block.style);
            style(block.mobileStyle);
            html(block.html);
            for (const column of block.columns)
              blocks(column);
          }
        };
        for (const section of design.sections) {
          style(section.style);
          blocks(section.blocks);
        }
        return requests;
      }
    }
  });

  // node_modules/@capiro/shared/dist/newsletter.js
  var require_newsletter = __commonJS({
    "node_modules/@capiro/shared/dist/newsletter.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.NEWSLETTER_SYSTEM_FONTS = exports.newsletterDesignFontRequests = exports.newsletterWebFontUrls = exports.newsletterCatalogStyle = exports.newsletterCatalogFont = exports.NEWSLETTER_FONT_CATALOG = exports.NEWSLETTER_SURVEY_SECTION_TYPES = exports.NEWSLETTER_SOCIAL_ICON_STYLES = exports.NEWSLETTER_SOCIAL_SHARE_PLATFORMS = exports.NEWSLETTER_SOCIAL_PLATFORMS = exports.NEWSLETTER_COLUMN_RATIOS = exports.NEWSLETTER_BLOCK_LABELS = exports.NEWSLETTER_BLOCK_KINDS = exports.NEWSLETTER_TEMPLATE_ID = void 0;
      exports.defaultNewsletterSocialShare = defaultNewsletterSocialShare;
      exports.createNewsletterSurveyQuestion = createNewsletterSurveyQuestion;
      exports.defaultNewsletterSurveyDefinition = defaultNewsletterSurveyDefinition;
      exports.newsletterVideoSource = newsletterVideoSource;
      exports.newsletterCustomVideoThumbnail = newsletterCustomVideoThumbnail;
      exports.defaultNewsletterSocialSettings = defaultNewsletterSocialSettings;
      exports.newsletterSocialPlatform = newsletterSocialPlatform;
      exports.newsletterSocialSettings = newsletterSocialSettings;
      exports.defaultNewsletterBrandKit = defaultNewsletterBrandKit;
      exports.newsletterBrandButtonStyle = newsletterBrandButtonStyle;
      exports.newsletterDesignFonts = newsletterDesignFonts;
      exports.applyNewsletterBrandKit = applyNewsletterBrandKit;
      exports.newsletterSourceClients = newsletterSourceClients;
      exports.newsletterId = newsletterId;
      exports.createNewsletterBlock = createNewsletterBlock2;
      exports.createNewsletterSection = createNewsletterSection;
      exports.defaultNewsletterStyles = defaultNewsletterStyles2;
      exports.defaultNewsletterConfig = defaultNewsletterConfig2;
      exports.createNewsletterLayout = createNewsletterLayout;
      exports.governmentAffairsNewsletter = governmentAffairsNewsletter;
      exports.visitNewsletterBlocks = visitNewsletterBlocks;
      exports.findNewsletterBlock = findNewsletterBlock;
      exports.cloneNewsletterBlocks = cloneNewsletterBlocks;
      exports.newsletterBlockVisible = newsletterBlockVisible;
      var newsletter_fonts_js_1 = require_newsletter_fonts();
      exports.NEWSLETTER_TEMPLATE_ID = "bp_weekly_newsletter";
      exports.NEWSLETTER_BLOCK_KINDS = [
        "image",
        "heading",
        "paragraph",
        "button",
        "divider",
        "spacer",
        "video",
        "social",
        "logo",
        "survey",
        "code",
        "apps",
        "product",
        "product-rec",
        "footer",
        "columns"
      ];
      exports.NEWSLETTER_BLOCK_LABELS = {
        image: "Image",
        heading: "Heading",
        paragraph: "Paragraph",
        button: "Button",
        divider: "Divider",
        spacer: "Spacer",
        video: "Video",
        social: "Social",
        logo: "Logo",
        survey: "Survey",
        code: "Code",
        apps: "Apps",
        product: "Product",
        "product-rec": "Product Rec",
        footer: "Footer",
        columns: "Columns"
      };
      exports.NEWSLETTER_COLUMN_RATIOS = ["1", "2", "3", "4", "1:2", "2:1", "1:3", "3:1"];
      exports.NEWSLETTER_SOCIAL_PLATFORMS = [
        ["instagram", "Instagram", "https://instagram.com/"],
        ["facebook", "Facebook", "https://facebook.com/"],
        ["twitter", "X (formerly Twitter)", "https://x.com/"],
        ["tiktok", "TikTok", "https://www.tiktok.com/"],
        ["youtube", "YouTube", "https://www.youtube.com/"],
        ["website", "Website", "https://"],
        ["email", "Email", "mailto:"],
        ["pinterest", "Pinterest", "https://www.pinterest.com/"],
        ["whatsapp", "WhatsApp", "https://wa.me/"],
        ["threads", "Threads", "https://www.threads.net/"],
        ["bluesky", "Bluesky", "https://bsky.app/"],
        ["linkedin", "LinkedIn", "https://www.linkedin.com/"],
        ["patreon", "Patreon", "https://www.patreon.com/"],
        ["discord", "Discord", "https://discord.gg/"],
        ["snapchat", "Snapchat", "https://www.snapchat.com/"],
        ["telegram", "Telegram", "https://t.me/"],
        ["spotify", "Spotify", "https://open.spotify.com/"],
        ["twitch", "Twitch", "https://www.twitch.tv/"],
        ["reddit", "Reddit", "https://www.reddit.com/"]
      ];
      exports.NEWSLETTER_SOCIAL_SHARE_PLATFORMS = [
        ["forward", "Forward to a friend"],
        ["facebook", "Facebook"],
        ["linkedin", "LinkedIn"],
        ["pinterest", "Pinterest"],
        ["twitter", "X (formerly Twitter)"],
        ["instapaper", "Instapaper"]
      ];
      function defaultNewsletterSocialShare() {
        return {
          source: "custom",
          customUrl: "",
          items: [
            { platform: "facebook", label: "Share" },
            { platform: "linkedin", label: "Share" }
          ]
        };
      }
      exports.NEWSLETTER_SOCIAL_ICON_STYLES = [
        ["color", "Color Icons"],
        ["dark", "Dark Icons"],
        ["light", "Light Icons"],
        ["gray", "Gray Icons"],
        ["color-white", "Color with White Icons"],
        ["dark-white", "Dark with White Icons"],
        ["light-black", "Light with Black Icons"],
        ["gray-black", "Gray with Black Icons"]
      ];
      exports.NEWSLETTER_SURVEY_SECTION_TYPES = [
        ["introduction", "Introduction"],
        ["radio", "Radio Buttons"],
        ["checkbox", "Checkboxes"],
        ["range", "Range"],
        ["text", "Open Text"],
        ["email", "Email"],
        ["contact", "Contact Information"],
        ["content", "Content Block"]
      ];
      function createNewsletterSurveyQuestion(type) {
        return {
          id: newsletterId(),
          type,
          prompt: "",
          required: false,
          options: [],
          other: false,
          range: { min: 1, max: 5, display: "numbers" },
          contactField: "firstName",
          askToSubscribe: false,
          imageUrl: "",
          alt: "",
          videoUrl: "",
          ...type === "introduction" ? { introductionType: null } : {}
        };
      }
      function defaultNewsletterSurveyDefinition() {
        return {
          version: 1,
          questions: [],
          title: "Tell us what matters to you",
          description: "",
          logoUrl: "",
          submitLabel: "Submit",
          confirmation: "Thank you for your feedback.",
          closedMessage: "This survey is closed.",
          requiredMessage: "Please answer this required question.",
          background: "#ffffff",
          buttonColor: "#007c89",
          buttonTextColor: "#ffffff"
        };
      }
      function newsletterVideoSource(value) {
        if (value.length > 2048)
          return null;
        let url;
        try {
          url = new URL(value.trim());
        } catch {
          return null;
        }
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port)
          return null;
        const host = url.hostname.toLowerCase();
        let id = "";
        if (["youtu.be", "www.youtu.be"].includes(host))
          id = url.pathname.match(/^\/([a-zA-Z0-9_-]{11})\/?$/)?.[1] || "";
        if ([
          "youtube.com",
          "www.youtube.com",
          "m.youtube.com",
          "music.youtube.com",
          "youtube-nocookie.com",
          "www.youtube-nocookie.com"
        ].includes(host)) {
          id = url.pathname === "/watch" && url.searchParams.getAll("v").length === 1 ? url.searchParams.get("v") || "" : url.pathname.match(/^\/(?:embed|shorts|live)\/([a-zA-Z0-9_-]{11})\/?$/)?.[1] || "";
        }
        if (/^[a-zA-Z0-9_-]{11}$/.test(id))
          return { provider: "youtube", url: `https://www.youtube.com/watch?v=${id}` };
        if (!["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(host))
          return null;
        const regular = /^\/\d{1,12}(?:\/[a-zA-Z0-9]{8,64})?\/?$/;
        const collection = /^\/(?:album|showcase)\/\d{1,12}\/video\/\d{1,12}\/?$/;
        const channel = /^\/(?:channels|ondemand)\/[a-zA-Z0-9_-]{1,100}\/\d{1,12}\/?$/;
        const group = /^\/groups\/[a-zA-Z0-9_-]{1,100}\/videos\/\d{1,12}\/?$/;
        if (host === "player.vimeo.com") {
          const playerId = url.pathname.match(/^\/video\/(\d{1,12})\/?$/)?.[1];
          if (!playerId)
            return null;
          url.pathname = `/${playerId}`;
        } else if (![regular, collection, channel, group].some((pattern) => pattern.test(url.pathname)))
          return null;
        const hash = url.searchParams.get("h");
        if (hash && !/^[a-zA-Z0-9]{8,64}$/.test(hash))
          return null;
        url.protocol = "https:";
        url.hostname = "vimeo.com";
        url.hash = "";
        url.search = "";
        if (hash)
          url.searchParams.set("h", hash);
        return { provider: "vimeo", url: url.href };
      }
      function newsletterCustomVideoThumbnail(block) {
        if (block.kind === "video")
          block.video = { ...block.video, thumbnail: "custom", sourceUrl: block.url };
      }
      function defaultNewsletterSocialSettings() {
        return {
          display: "icon",
          iconStyle: "dark",
          desktop: { layout: "horizontal", size: "large", spacing: 24 },
          mobile: { layout: "horizontal", size: "large", spacing: 24 }
        };
      }
      function newsletterSocialPlatform(item) {
        if (item.platform)
          return item.platform;
        const value = `${item.url} ${item.label}`.toLowerCase();
        const match = [
          [/instagram/, "instagram"],
          [/facebook/, "facebook"],
          [/twitter|x\.com/, "twitter"],
          [/tiktok/, "tiktok"],
          [/youtube|youtu\.be/, "youtube"],
          [/mailto:|^email/, "email"],
          [/pinterest/, "pinterest"],
          [/whatsapp|wa\.me/, "whatsapp"],
          [/threads/, "threads"],
          [/bluesky|bsky/, "bluesky"],
          [/linkedin/, "linkedin"],
          [/patreon/, "patreon"],
          [/discord/, "discord"],
          [/snapchat/, "snapchat"],
          [/telegram|t\.me\//, "telegram"],
          [/spotify/, "spotify"],
          [/twitch/, "twitch"],
          [/reddit/, "reddit"]
        ];
        return match.find(([pattern]) => pattern.test(value))?.[1] || "website";
      }
      function newsletterSocialSettings(block) {
        return block.social || { ...defaultNewsletterSocialSettings(), display: "text" };
      }
      var newsletter_fonts_js_2 = require_newsletter_fonts();
      Object.defineProperty(exports, "NEWSLETTER_FONT_CATALOG", { enumerable: true, get: function() {
        return newsletter_fonts_js_2.NEWSLETTER_FONT_CATALOG;
      } });
      Object.defineProperty(exports, "newsletterCatalogFont", { enumerable: true, get: function() {
        return newsletter_fonts_js_2.newsletterCatalogFont;
      } });
      Object.defineProperty(exports, "newsletterCatalogStyle", { enumerable: true, get: function() {
        return newsletter_fonts_js_2.newsletterCatalogStyle;
      } });
      Object.defineProperty(exports, "newsletterWebFontUrls", { enumerable: true, get: function() {
        return newsletter_fonts_js_2.newsletterWebFontUrls;
      } });
      Object.defineProperty(exports, "newsletterDesignFontRequests", { enumerable: true, get: function() {
        return newsletter_fonts_js_2.newsletterDesignFontRequests;
      } });
      exports.NEWSLETTER_SYSTEM_FONTS = [
        "Arial",
        "Helvetica",
        "Courier New",
        "Georgia",
        "Times New Roman",
        "Verdana",
        "Tahoma",
        "Trebuchet MS"
      ];
      function defaultNewsletterBrandKit() {
        return {
          revision: 1,
          updatedAt: "",
          logos: [],
          primaryLogoId: null,
          colors: { primary: ["#ffffff", "#141414", "#131a2b"], secondary: [] },
          fonts: { heading: "Arial", body: "Courier New", uploaded: [] },
          buttons: ["#ffffff", "#000000", "#131a2b", "#ffffff"].map((background, index) => ({
            id: `brand-button-${index + 1}`,
            name: `Button ${index + 1}`,
            shape: "pill",
            variant: index === 3 ? "outlined" : "filled",
            background,
            color: index === 0 ? "#131a2b" : "#ffffff",
            fontFamily: "Arial"
          })),
          primaryButtonId: null
        };
      }
      function newsletterBrandButtonStyle(button) {
        const font = (0, newsletter_fonts_js_1.newsletterCatalogStyle)(button.fontFamily);
        return {
          background: button.variant === "outlined" ? "transparent" : button.background,
          color: button.color,
          fontFamily: button.fontFamily,
          fontWeight: font?.fontWeight ?? 400,
          bold: (font?.fontWeight ?? 400) >= 700,
          italic: font?.fontStyle === "italic",
          radius: button.shape === "pill" ? 1e3 : button.shape === "rounded" ? 8 : 0,
          borderStyle: button.variant === "outlined" ? "solid" : "none",
          borderWidth: button.variant === "outlined" ? 1 : 0,
          borderColor: button.background
        };
      }
      function newsletterDesignFonts(design) {
        return [
          ...new Map([...design.fonts ?? [], ...design.sections.flatMap((section) => section.fonts ?? [])].map((font) => [font.assetId, font])).values()
        ];
      }
      function applyNewsletterBrandKit(design, kit) {
        design.fonts = [
          ...new Map([...newsletterDesignFonts(design), ...kit.fonts.uploaded].map((font) => [font.assetId, font])).values()
        ];
        for (const types of [design.styles.text, design.styles.mobileText]) {
          for (const key of ["h1", "h2", "h3", "h4"])
            Object.assign(types[key], {
              fontFamily: kit.fonts.heading,
              fontWeight: (0, newsletter_fonts_js_1.newsletterCatalogStyle)(kit.fonts.heading)?.fontWeight ?? 400,
              italic: (0, newsletter_fonts_js_1.newsletterCatalogStyle)(kit.fonts.heading)?.fontStyle === "italic"
            });
          Object.assign(types.p, {
            fontFamily: kit.fonts.body,
            fontWeight: (0, newsletter_fonts_js_1.newsletterCatalogStyle)(kit.fonts.body)?.fontWeight ?? 400,
            italic: (0, newsletter_fonts_js_1.newsletterCatalogStyle)(kit.fonts.body)?.fontStyle === "italic"
          });
        }
        const logo = kit.logos.find((logo2) => logo2.assetId === kit.primaryLogoId);
        const button = kit.buttons.find((button2) => button2.id === kit.primaryButtonId);
        if (button) {
          Object.assign(design.styles.button, newsletterBrandButtonStyle(button));
          Object.assign(design.styles.mobileButton, newsletterBrandButtonStyle(button));
        }
        visitNewsletterBlocks(design, (block) => {
          if (logo && block.kind === "logo")
            Object.assign(block, {
              imageUrl: logo.url,
              url: logo.link,
              linkType: "web",
              alt: logo.alt,
              text: "",
              crop: null
            });
          if (button && block.kind === "button") {
            Object.assign(block.style, newsletterBrandButtonStyle(button));
            Object.assign(block.mobileStyle, newsletterBrandButtonStyle(button));
          }
          if (block.kind === "heading") {
            block.style.fontFamily = kit.fonts.heading;
            block.mobileStyle.fontFamily = kit.fonts.heading;
            for (const style of [block.style, block.mobileStyle])
              Object.assign(style, {
                fontWeight: (0, newsletter_fonts_js_1.newsletterCatalogStyle)(kit.fonts.heading)?.fontWeight ?? 400,
                italic: (0, newsletter_fonts_js_1.newsletterCatalogStyle)(kit.fonts.heading)?.fontStyle === "italic"
              });
          }
          if (block.kind === "paragraph") {
            block.style.fontFamily = kit.fonts.body;
            block.mobileStyle.fontFamily = kit.fonts.body;
            for (const style of [block.style, block.mobileStyle])
              Object.assign(style, {
                fontWeight: (0, newsletter_fonts_js_1.newsletterCatalogStyle)(kit.fonts.body)?.fontWeight ?? 400,
                italic: (0, newsletter_fonts_js_1.newsletterCatalogStyle)(kit.fonts.body)?.fontStyle === "italic"
              });
          }
        });
      }
      function newsletterSourceClients(design, clientId) {
        const surveyClients = [];
        visitNewsletterBlocks(design, (block) => surveyClients.push(...block.survey?.saved?.sourceClientIds || []));
        return [
          .../* @__PURE__ */ new Set([
            ...design.sourceClientIds ?? [],
            ...design.sections.flatMap((section) => section.sourceClientIds ?? []),
            ...surveyClients,
            ...clientId ? [clientId] : []
          ])
        ];
      }
      function newsletterId() {
        return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
      }
      function createNewsletterBlock2(kind, overrides = {}) {
        return {
          id: newsletterId(),
          kind,
          html: "",
          text: kind === "heading" ? "Add heading text" : kind === "survey" ? "Start Survey" : kind === "button" ? "Add button text" : kind === "paragraph" ? "Add your text here." : "",
          url: "",
          imageUrl: "",
          alt: "",
          headingLevel: 2,
          linkType: "web",
          openNewTab: true,
          imageSize: "fill",
          imageScale: 100,
          crop: null,
          items: kind === "social" ? [
            { platform: "facebook", label: "Facebook", url: "https://facebook.com/" },
            { platform: "instagram", label: "Instagram", url: "https://instagram.com/" },
            { platform: "twitter", label: "X", url: "https://x.com/" }
          ] : [],
          question: "How useful was this update?",
          options: ["Very useful", "Somewhat useful", "Not useful"],
          sourceKind: "news",
          ratio: "2",
          mobileOrientation: "stacked",
          columns: kind === "columns" ? [[], []] : [],
          style: {},
          mobileStyle: {},
          linkedStyles: true,
          visibility: { mode: "all", rules: [] },
          ...kind === "social" ? { social: defaultNewsletterSocialSettings() } : {},
          ...kind === "survey" ? {
            survey: {
              kind: "saved-survey",
              saved: null,
              blockBackground: "",
              paddingLinked: false
            },
            style: { align: "center" }
          } : {},
          ...kind === "video" ? {
            video: { thumbnail: "auto", sourceUrl: "" },
            style: { paddingTop: 12, paddingBottom: 12, paddingLeft: 24, paddingRight: 24 }
          } : {},
          ...overrides
        };
      }
      function createNewsletterSection(name, blocks = []) {
        return { id: newsletterId(), name, style: {}, blocks };
      }
      function defaultNewsletterStyles2() {
        const text = {
          p: { fontFamily: "Courier New", fontSize: 14, color: "#ffffff", lineHeight: 1.4 },
          h1: { fontFamily: "Arial", fontSize: 48, color: "#ffffff", bold: true, lineHeight: 1.1 },
          h2: { fontFamily: "Arial", fontSize: 36, color: "#ffffff", bold: true, lineHeight: 1.2 },
          h3: { fontFamily: "Arial", fontSize: 24, color: "#f05f26", bold: true, lineHeight: 1.3 },
          h4: { fontFamily: "Arial", fontSize: 18, color: "#ffffff", bold: true, lineHeight: 1.3 }
        };
        return {
          background: "#141414",
          content: "#141414",
          backgroundImage: "",
          width: 660,
          mobilePadding: 16,
          text,
          mobileText: structuredClone(text),
          link: { color: "#ffffff", underline: true },
          button: {
            background: "#141414",
            color: "#ffffff",
            borderColor: "#f05f26",
            borderStyle: "solid",
            borderWidth: 1,
            fontFamily: "Arial",
            fontSize: 16,
            paddingTop: 12,
            paddingBottom: 12,
            paddingLeft: 24,
            paddingRight: 24,
            radius: 0
          },
          divider: {
            borderStyle: "solid",
            borderColor: "#777777",
            borderWidth: 1,
            paddingTop: 12,
            paddingBottom: 12
          },
          image: { radius: 0, width: 100 },
          logo: { align: "left" },
          linkedStyles: true,
          mobileButton: {},
          mobileDivider: {},
          mobileImage: {},
          mobileLogo: {}
        };
      }
      function defaultNewsletterConfig2() {
        return {
          clientId: null,
          clientName: "",
          fromName: "",
          fromEmail: "",
          replyTo: "",
          subject: "",
          previewText: "",
          recipientIds: [],
          excludeRecipientIds: [],
          personalizeTo: false,
          toName: "*|FNAME|* *|LNAME|*",
          schedule: {
            mode: "now",
            sendAt: null,
            timeZone: "America/New_York",
            optimization: false,
            timewarp: false,
            batch: false,
            batchCount: 2,
            batchMinutes: 30,
            trigger: "signup",
            triggerValue: ""
          },
          tracking: {
            opens: true,
            clicks: true,
            plainTextClicks: false,
            inbox: false,
            autoConvertVideo: false,
            ecommerce: false,
            googleAnalytics: false,
            googleAnalyticsTitle: "",
            clickTale: false
          },
          autoResend: {
            enabled: false,
            afterDays: 3,
            time: "09:00",
            subject: "",
            audience: "not-opened",
            ignoreBotOpens: true
          },
          experiment: {
            enabled: false,
            subjects: ["", ""],
            testPercent: 20,
            winnerMetric: "opens",
            waitHours: 4
          },
          socialCard: { enabled: false, title: "", description: "", imageUrl: "" },
          shareSlug: "",
          company: "",
          mailingAddress: "",
          permissionReminder: "You are receiving this briefing because you subscribed to updates from our team.",
          plainText: "",
          plainTextAuto: true
        };
      }
      function createNewsletterLayout(columns = 1, code = false) {
        const content = code ? [createNewsletterBlock2("code", { html: "<p>Add your newsletter HTML here.</p>" })] : [
          createNewsletterBlock2("heading", { text: "This week in policy", headingLevel: 1 }),
          ...columns === 1 ? [createNewsletterBlock2("paragraph")] : [
            createNewsletterBlock2("columns", {
              ratio: String(columns),
              columns: Array.from({ length: columns }, () => [
                createNewsletterBlock2("paragraph")
              ])
            })
          ]
        ];
        return {
          version: 1,
          styles: defaultNewsletterStyles2(),
          sections: [
            createNewsletterSection("Header", [createNewsletterBlock2("logo", { text: "YOUR FIRM" })]),
            createNewsletterSection("Body", content),
            createNewsletterSection("Footer", [createNewsletterBlock2("footer")])
          ]
        };
      }
      function governmentAffairsNewsletter() {
        const b = createNewsletterBlock2;
        const paragraph = (text, style = {}) => b("paragraph", { text, style });
        const heading = (text, headingLevel = 2) => b("heading", { text, headingLevel });
        const button = (text, url) => b("button", { text, url });
        const columns = (left, right) => b("columns", { columns: [left, right] });
        return {
          version: 1,
          styles: defaultNewsletterStyles2(),
          sections: [
            createNewsletterSection("Header", [
              b("paragraph", {
                html: '<a href="*|ARCHIVE|*">View this email in your browser</a>',
                style: { fontSize: 11, underline: true }
              }),
              b("divider"),
              b("logo", {
                text: "CAPIRO",
                alt: "Your firm logo",
                style: {
                  color: "#f05f26",
                  fontSize: 64,
                  fontFamily: "Arial",
                  bold: true,
                  paddingTop: 12,
                  paddingBottom: 24
                }
              })
            ]),
            createNewsletterSection("Body", [
              b("divider"),
              paragraph("OCTOBER 6, 2026 \xB7 WEEKLY CLIENT BRIEFING", { fontSize: 12 }),
              b("divider"),
              heading("The week in policy.\nWhat it means for you.", 1),
              b("image", {
                imageUrl: "/newsletter/capitol.png",
                alt: "Illustration of the U.S. Capitol",
                style: { paddingTop: 16, paddingBottom: 24 }
              }),
              columns([
                paragraph("LEGISLATIVE WATCH", { color: "#f05f26", bold: true }),
                paragraph("H.R. XXXX \xB7 Sample Infrastructure Modernization Act\n\nIllustrative update: the committee has published proposed language for stakeholder review. Our team is tracking changes to eligibility, funding and reporting requirements.")
              ], [
                paragraph("WHAT THIS MEANS FOR YOUR TEAM", { color: "#f05f26", bold: true }),
                paragraph("Use this space to connect a bill\u2019s latest action to your client\u2019s priorities. Summarize the impact, link to the source and explain the next decision or deadline. This preview uses sample material.")
              ]),
              button("Read the bill update", "https://www.congress.gov/"),
              b("spacer", { style: { height: 24 } }),
              heading("Your priorities.\nOur watchlist.\nA clear next step."),
              heading("Plan for the week ahead.", 3),
              b("divider"),
              columns([
                paragraph("UP NEXT \xB7 SAMPLE POLICY CALENDAR", { color: "#f05f26", bold: true }),
                paragraph("Committee hearing \xB7 stakeholder comments \xB7 agency guidance\n\nHighlight the dates your client needs to know and the actions your team recommends."),
                button("Review upcoming hearings", "https://www.congress.gov/committee-schedule")
              ], [
                b("image", {
                  imageUrl: "/newsletter/policy-desk.png",
                  alt: "Illustration of a policy briefing desk"
                })
              ]),
              b("divider"),
              heading("News that moves\nyour agenda."),
              b("image", {
                imageUrl: "/newsletter/newsroom.png",
                alt: "Illustration of policy news headlines"
              }),
              columns([
                paragraph("IN THE NEWS", { color: "#f05f26", bold: true }),
                paragraph("Sample news brief: an agency outlines its next rulemaking priorities. Add a sourced headline, a concise summary and a note on why this development matters to your client.")
              ], [
                paragraph("OUR TAKE", { color: "#f05f26", bold: true }),
                paragraph("Explain the implications in plain language. Separate the source\u2019s reported facts from your analysis, and identify what your client should watch next.")
              ]),
              button("Explore policy news", "https://www.federalregister.gov/"),
              b("divider"),
              columns([
                b("image", {
                  imageUrl: "/newsletter/social-update.png",
                  alt: "Illustration of a social media update"
                })
              ], [
                paragraph("ON OUR RADAR \xB7 SAMPLE TWEET", { color: "#f05f26", bold: true }),
                paragraph("@PolicyDesk (illustrative)\n\u201CStakeholder input helps shape the next phase of policy work.\u201D\n\nUse this section for a relevant tweet, its source link and context for your client."),
                button("Read the original post", "https://x.com/")
              ]),
              b("social", {
                social: { ...defaultNewsletterSocialSettings(), display: "text" },
                items: [
                  { label: "LINKEDIN", url: "https://www.linkedin.com/" },
                  { label: "X / TWITTER", url: "https://x.com/" },
                  { label: "WEBSITE", url: "https://capiro.ai/" }
                ],
                style: { align: "center", fontSize: 12, paddingTop: 24, paddingBottom: 24 }
              })
            ]),
            createNewsletterSection("Footer", [
              b("footer", {
                style: {
                  fontSize: 11,
                  align: "center",
                  color: "#cccccc",
                  paddingTop: 24,
                  paddingBottom: 24
                }
              }),
              b("logo", {
                text: "CAPIRO",
                alt: "Your firm logo",
                style: {
                  align: "right",
                  fontFamily: "Arial",
                  fontSize: 30,
                  bold: true,
                  color: "#f05f26"
                }
              })
            ])
          ]
        };
      }
      function visitNewsletterBlocks(design, visit) {
        const walk = (blocks, section) => {
          for (const block of blocks) {
            visit(block, section);
            for (const column of block.columns)
              walk(column, section);
          }
        };
        for (const section of design.sections)
          walk(section.blocks, section);
      }
      function findNewsletterBlock(design, id) {
        let found = null;
        visitNewsletterBlocks(design, (block) => {
          if (block.id === id)
            found = block;
        });
        return found;
      }
      function cloneNewsletterBlocks(blocks) {
        return blocks.map((block) => ({
          ...structuredClone(block),
          id: newsletterId(),
          columns: block.columns.map(cloneNewsletterBlocks)
        }));
      }
      function newsletterBlockVisible(block, recipient) {
        if (block.visibility.mode === "all")
          return true;
        if (!recipient)
          return false;
        return block.visibility.rules.every((rule) => {
          const raw = recipient[rule.field];
          const value = (Array.isArray(raw) ? raw.join(",") : String(raw ?? "")).toLowerCase();
          const match = rule.value.toLowerCase();
          switch (rule.operator) {
            case "is":
              return value === match;
            case "is-not":
              return value !== match;
            case "contains":
              return value.includes(match);
            case "does-not-contain":
              return !value.includes(match);
            case "is-empty":
              return !value.trim();
            case "is-not-empty":
              return Boolean(value.trim());
          }
        });
      }
    }
  });

  // node_modules/@capiro/shared/dist/newsletter-social-share.js
  var require_newsletter_social_share = __commonJS({
    "node_modules/@capiro/shared/dist/newsletter-social-share.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.newsletterSocialShareTarget = newsletterSocialShareTarget2;
      exports.newsletterSocialShareUrl = newsletterSocialShareUrl;
      exports.newsletterSocialShareItems = newsletterSocialShareItems;
      var newsletter_js_1 = require_newsletter();
      function newsletterSocialShareTarget2(value) {
        if (value.length > 4e3 || /[\x00-\x1f\x7f]|\*\|/.test(value))
          return "";
        try {
          const url = new URL(value.trim());
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
            return "";
          const path = decodeURIComponent(url.pathname);
          if (/\/engagement\/newsletter-public(?:\/|$)/i.test(path))
            return "";
          return url.href;
        } catch {
          return "";
        }
      }
      function newsletterSocialShareUrl(platform, target) {
        const safe = newsletterSocialShareTarget2(target);
        if (!safe)
          return "";
        const value = encodeURIComponent(safe);
        switch (platform) {
          case "facebook":
            return `https://www.facebook.com/sharer/sharer.php?u=${value}`;
          case "linkedin":
            return `https://www.linkedin.com/sharing/share-offsite/?url=${value}`;
          case "pinterest":
            return `https://pinterest.com/pin/create/button/?url=${value}&media=Newsletter`;
          case "twitter":
            return `https://twitter.com/intent/tweet?text=Newsletter:%20${value}`;
          case "instapaper":
            return `https://www.instapaper.com/hello2?url=${value}&title=Newsletter`;
          case "forward":
            return "";
          default:
            return "";
        }
      }
      function newsletterSocialShareItems(block) {
        const share = block.social?.share || (0, newsletter_js_1.defaultNewsletterSocialShare)();
        const target = share.source === "custom" ? share.customUrl : "";
        return share.items.map((item) => ({
          ...item,
          url: newsletterSocialShareUrl(item.platform, target)
        }));
      }
    }
  });

  // node_modules/@capiro/shared/dist/newsletter-render.js
  var require_newsletter_render = __commonJS({
    "node_modules/@capiro/shared/dist/newsletter-render.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.newsletterSocialShareItems = exports.newsletterSocialShareUrl = exports.newsletterSocialShareTarget = void 0;
      exports.newsletterFontCss = newsletterFontCss;
      exports.newsletterEscape = newsletterEscape;
      exports.newsletterSafeUrl = newsletterSafeUrl;
      exports.newsletterStyleCss = newsletterStyleCss;
      exports.newsletterBundledImageUrl = newsletterBundledImageUrl;
      exports.newsletterMergeText = newsletterMergeText;
      exports.newsletterSocialIconSize = newsletterSocialIconSize;
      exports.renderNewsletterBlock = renderNewsletterBlock2;
      exports.renderNewsletterDesign = renderNewsletterDesign;
      exports.newsletterPlainText = newsletterPlainText;
      var newsletter_js_1 = require_newsletter();
      var newsletter_fonts_js_1 = require_newsletter_fonts();
      var newsletter_social_share_js_1 = require_newsletter_social_share();
      var newsletter_social_share_js_2 = require_newsletter_social_share();
      Object.defineProperty(exports, "newsletterSocialShareTarget", { enumerable: true, get: function() {
        return newsletter_social_share_js_2.newsletterSocialShareTarget;
      } });
      Object.defineProperty(exports, "newsletterSocialShareUrl", { enumerable: true, get: function() {
        return newsletter_social_share_js_2.newsletterSocialShareUrl;
      } });
      Object.defineProperty(exports, "newsletterSocialShareItems", { enumerable: true, get: function() {
        return newsletter_social_share_js_2.newsletterSocialShareItems;
      } });
      function newsletterFontCss(fonts) {
        return fonts.filter((font) => /^CapiroFont-[a-f\d-]{36}$/i.test(font.family) && ["truetype", "opentype", "woff", "woff2"].includes(font.format) && /^https?:\/\//i.test(newsletterSafeUrl(font.url, true))).map((font) => `@font-face{font-family:'${font.family}';src:url('${newsletterCssUrl(font.url)}') format('${font.format}');font-display:swap;}`).join("");
      }
      function newsletterEscape(value) {
        return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      }
      function newsletterSafeUrl(raw, allowImage = false) {
        const value = String(raw ?? "").trim();
        if (!allowImage && /^\*\|(?:ARCHIVE|UNSUB|UPDATE_PROFILE)\|\*$/.test(value))
          return value;
        if (!allowImage && /^#[a-z0-9_-]+$/i.test(value) || /^\/newsletter\/[a-z0-9._-]+$/i.test(value))
          return value;
        if (allowImage && /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value))
          return value;
        if ((allowImage ? /^https?:\/\//i : /^(https?:\/\/|mailto:|tel:)/i).test(value)) {
          try {
            const url = new URL(value);
            if (url.username || url.password)
              return "";
            return url.href;
          } catch {
            return "";
          }
        }
        return "";
      }
      function newsletterStyleCss(style) {
        const css = [];
        const cornerNames = {
          radiusTopLeft: "border-top-left-radius",
          radiusTopRight: "border-top-right-radius",
          radiusBottomRight: "border-bottom-right-radius",
          radiusBottomLeft: "border-bottom-left-radius"
        };
        const font = style.fontFamily ? (0, newsletter_fonts_js_1.newsletterCatalogStyle)(style.fontFamily) : void 0;
        for (const [key, value] of Object.entries(style)) {
          if (value === void 0 || value === null)
            continue;
          if (key in cornerNames)
            continue;
          const name = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
          if (["background", "color", "borderColor"].includes(key) && /^(#[a-f0-9]{3,8}|transparent)$/i.test(String(value)))
            css.push(`${name}:${value}`);
          else if (key === "fontFamily" && /^[a-z0-9 ,'-]{1,100}$/i.test(String(value)))
            css.push(`font-family:${font?.fontFamily ?? value}`);
          else if ([
            "fontSize",
            "letterSpacing",
            "paragraphSpacing",
            "paddingTop",
            "paddingBottom",
            "paddingLeft",
            "paddingRight",
            "margin",
            "borderWidth",
            "radius",
            "height"
          ].includes(key) && typeof value === "number" && Number.isFinite(value))
            css.push(`${key === "radius" ? "border-radius" : key === "paragraphSpacing" ? "margin-bottom" : name}:${Math.max(0, Math.min(1e3, value))}px`);
          else if (key === "width" && typeof value === "number" && Number.isFinite(value))
            css.push(`width:${Math.max(1, Math.min(100, value))}%`);
          else if (key === "lineHeight" && typeof value === "number" && Number.isFinite(value))
            css.push(`line-height:${Math.max(0.5, Math.min(4, value))}`);
          else if (key === "bold" || key === "italic" || key === "fontWeight")
            continue;
          else if (key === "underline" || key === "strike")
            css.push(`text-decoration:${value ? key === "strike" ? "line-through" : "underline" : "none"}`);
          else if (key === "align" && ["left", "center", "right"].includes(String(value)))
            css.push(`text-align:${value}`);
          else if (key === "direction" && ["ltr", "rtl"].includes(String(value)))
            css.push(`direction:${value}`);
          else if (key === "borderStyle" && [
            "none",
            "solid",
            "dashed",
            "dotted",
            "double",
            "inset",
            "outset",
            "groove",
            "ridge"
          ].includes(String(value)))
            css.push(`border-style:${value}`);
        }
        for (const [key, name] of Object.entries(cornerNames)) {
          const value = style[key];
          if (typeof value === "number" && Number.isFinite(value))
            css.push(`${name}:${Math.max(0, Math.min(1e3, value))}px`);
        }
        const weight = typeof style.fontWeight === "number" && Number.isFinite(style.fontWeight) ? Math.max(100, Math.min(900, Math.round(style.fontWeight))) : void 0;
        if (weight !== void 0 || font || style.bold !== void 0)
          css.push(`font-weight:${weight ?? (style.bold === void 0 ? font.fontWeight : style.bold ? 700 : 400)}`);
        if (font || style.italic !== void 0)
          css.push(`font-style:${style.italic === void 0 ? font.fontStyle : style.italic ? "italic" : "normal"}`);
        return css.join(";");
      }
      function newsletterBundledImageUrl(url) {
        return url.replace(/^\/newsletter\/(capitol|policy-desk|newsroom|social-update)\.svg$/, "/newsletter/$1.png");
      }
      function newsletterCssUrl(raw) {
        return newsletterSafeUrl(raw, true).replace(/[()'"\\]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      }
      function newsletterMergeText(value, config, options = {}) {
        if (!options.liveMergeTags)
          return value;
        const recipient = options.recipient;
        const fields = {
          FNAME: recipient?.firstName ?? "Client",
          LNAME: recipient?.lastName ?? "",
          EMAIL: recipient?.email ?? "client@example.com",
          COMPANY: recipient?.company ?? "",
          "LIST:COMPANY": config.company || config.fromName || "Your firm",
          "HTML:LIST_ADDRESS": config.mailingAddress || "Add your firm mailing address",
          "LIST:DESCRIPTION": config.permissionReminder,
          CURRENT_YEAR: String((/* @__PURE__ */ new Date()).getFullYear()),
          "MC:SUBJECT": config.subject,
          ARCHIVE: options.archiveUrl ?? "#archive",
          UNSUB: options.unsubscribeUrl ?? "#unsubscribe",
          UPDATE_PROFILE: options.preferencesUrl ?? "#preferences"
        };
        return value.replace(/\*\|([^|]+)\|\*/g, (match, field) => fields[field] ?? match);
      }
      function newsletterSocialIconSize(size) {
        return size === "small" ? 24 : size === "medium" ? 32 : 40;
      }
      function socialItemLayout(device, align) {
        return device.layout === "horizontal" ? `display:inline-table;margin:0 ${device.spacing}px 0 0;vertical-align:middle` : `display:table;margin:0 ${align === "right" ? "0" : "auto"} ${device.spacing}px ${align === "left" ? "0" : "auto"};vertical-align:middle`;
      }
      function socialTextStyle(style) {
        return Object.fromEntries(Object.entries(style).filter(([key]) => [
          "color",
          "fontFamily",
          "fontSize",
          "fontWeight",
          "bold",
          "italic",
          "underline",
          "strike",
          "lineHeight",
          "letterSpacing",
          "direction"
        ].includes(key)));
      }
      function renderNewsletterBlock2(block, design, config, options = {}) {
        if (!options.editor && !(0, newsletter_js_1.newsletterBlockVisible)(block, options.recipient))
          return "";
        const button = block.kind === "button" || block.kind === "survey" && !!block.survey;
        const defaults = block.kind === "heading" ? design.styles.text[`h${block.headingLevel}`] : block.kind === "paragraph" || block.kind === "apps" || block.kind === "code" || block.kind === "footer" ? design.styles.text.p : button ? design.styles.button : block.kind === "divider" ? design.styles.divider : block.kind === "logo" ? design.styles.logo : block.kind === "image" ? design.styles.image : {};
        const style = { ...defaults, ...block.style };
        const innerStyle = { ...style };
        if (!button) {
          delete innerStyle.paddingTop;
          delete innerStyle.paddingBottom;
          delete innerStyle.paddingLeft;
          delete innerStyle.paddingRight;
          delete innerStyle.margin;
        }
        const css = newsletterStyleCss(innerStyle);
        const text = (value) => newsletterEscape(newsletterMergeText(value, config, options)).replace(/\n/g, "<br>");
        const link = (value) => {
          let url = newsletterSafeUrl(newsletterMergeText(value, config, options));
          if (url.startsWith("/newsletter/") && options.publicUrl)
            url = `${options.publicUrl.replace(/\/$/, "")}${url}`;
          return newsletterEscape(url ? options.rewriteLink?.(url, block.id) ?? url : "#");
        };
        const rich = (html) => {
          const merged = options.liveMergeTags ? html.replace(/\*\|[^|]+\|\*/g, (tag) => newsletterEscape(newsletterMergeText(tag, config, options))) : html;
          const safe = options.sanitizeHtml?.(merged) ?? text(merged);
          return safe.replace(/<a\b([^>]*)>/gi, (_tag, attrs) => {
            const withoutStyle = attrs.replace(/\sstyle="[^"]*"/gi, "");
            return `<a${withoutStyle} style="${newsletterStyleCss(design.styles.link)}">`;
          });
        };
        const image = (url, alt, extra = "", wrapLink = true) => {
          let safe = newsletterBundledImageUrl(newsletterSafeUrl(url, true));
          if (safe.startsWith("/newsletter/") && options.publicUrl)
            safe = `${options.publicUrl.replace(/\/$/, "")}${safe}`;
          if (!safe)
            return `<div style="background:#eee;color:#666;padding:48px 12px;text-align:center;font-family:Arial">Add an image</div>`;
          const width = block.imageSize === "scale" ? Math.max(1, Math.min(100, block.imageScale)) : block.imageSize === "original" ? "auto" : 100;
          const crop = block.crop ? `object-fit:cover;object-position:${block.crop.x}% ${block.crop.y}%;aspect-ratio:${block.crop.width}/${block.crop.height};` : "";
          const alignment = style.align === "center" ? "margin-left:auto;margin-right:auto;" : style.align === "right" ? "margin-left:auto;margin-right:0;" : "margin-left:0;margin-right:auto;";
          const imageCss = newsletterStyleCss({ ...innerStyle, width: void 0 });
          const result = `<img src="${newsletterEscape(safe)}" alt="${newsletterEscape(alt)}" style="max-width:100%;width:${width === "auto" ? "auto" : `${width}%`};display:block;border:0;${imageCss};${alignment}${crop}${extra}">`;
          return block.url && wrapLink ? `<a href="${link(block.url)}"${block.openNewTab ? ' target="_blank" rel="noopener noreferrer"' : ""}>${result}</a>` : result;
        };
        let content = "";
        switch (block.kind) {
          case "heading":
            content = `<h${block.headingLevel} style="margin:0;${css}">${block.html ? rich(block.html) : text(block.text)}</h${block.headingLevel}>`;
            break;
          case "paragraph":
            content = `<div style="${css}">${block.html ? rich(block.html) : text(block.text)}</div>`;
            break;
          case "apps": {
            const app = block.app;
            if (!app?.sourceUrl || !app.title) {
              content = options.editor ? '<div style="padding:36px 16px;background:#f3f4f6;color:#374151;text-align:center;font-family:Arial">Select an app to add content</div>' : "";
              break;
            }
            const maxWidth = app.size === "small" ? "240px" : app.size === "medium" ? "400px" : "100%";
            const foreground = block.style.color || (app.showBackground ? "#1f2937" : style.color || "#1f2937");
            const cardCss = newsletterStyleCss({ ...innerStyle, color: foreground });
            const thumbnail = app.showImage && newsletterSafeUrl(app.imageUrl, true) ? `<img src="${newsletterEscape(newsletterSafeUrl(app.imageUrl, true))}" alt="${newsletterEscape(app.title)}" width="${app.size === "small" ? 240 : app.size === "medium" ? 400 : design.styles.width}" style="display:block;width:100%;max-width:100%;height:auto;border:0;margin:0 0 12px">` : "";
            content = `<a href="${newsletterEscape(newsletterSafeUrl(app.sourceUrl))}"${block.openNewTab ? ' target="_blank" rel="noopener noreferrer"' : ""} style="display:block;width:100%;max-width:${maxWidth};box-sizing:border-box;text-decoration:none;${cardCss};${app.showBackground ? `background:${block.style.background || "#f3f4f6"};padding:16px;` : ""}">${thumbnail}<div style="font-weight:bold;font-size:18px;line-height:1.4">${newsletterEscape(app.title)}</div>${app.showDescription && app.description ? `<p style="margin:8px 0 0;font-size:14px;line-height:1.5">${newsletterEscape(app.description)}</p>` : ""}</a>`;
            break;
          }
          case "code":
            content = options.sanitizeHtml ? rich(block.html || block.text) : `<pre style="white-space:pre-wrap;${css}">${text(block.html || block.text)}</pre>`;
            break;
          case "image":
            content = image(block.imageUrl, block.alt);
            break;
          case "logo":
            content = block.imageUrl ? image(block.imageUrl, block.alt) : `<div style="${css}">${text(block.text || "Your logo")}</div>`;
            break;
          case "button":
            content = `<div style="text-align:${style.align ?? "left"}"><a href="${link(block.url)}"${block.openNewTab ? ' target="_blank" rel="noopener noreferrer"' : ""} style="display:inline-block;text-decoration:none;${css}">${text(block.text)}</a></div>`;
            break;
          case "divider":
            content = `<div style="border-top:${style.borderWidth ?? 1}px ${style.borderStyle ?? "solid"} ${style.borderColor ?? "#777"};height:0"></div>`;
            break;
          case "spacer":
            content = `<div style="height:${Math.max(0, Math.min(500, style.height ?? 24))}px;line-height:1px" aria-hidden="true">&nbsp;</div>`;
            break;
          case "video":
            content = `<div style="${newsletterStyleCss({ background: style.background, align: style.align })}"><a href="${link(block.url)}"${block.openNewTab ? ' target="_blank" rel="noopener noreferrer"' : ""} style="display:block;color:${design.styles.link.color ?? "#fff"}">${block.imageUrl ? image(block.imageUrl, block.alt || "Watch video", "", false) : `<div style="padding:36px;background:#333;text-align:center;font-size:36px" aria-label="Add video URL">&#9654;</div>`}${!block.video && block.text ? `<span>${text(block.text)}</span>` : ""}</a></div>`;
            break;
          case "social":
            if (!block.social) {
              content = `<div style="${css}">${block.items.map((item) => `<a href="${link(item.url)}" style="color:${style.color ?? design.styles.link.color};display:inline-block;margin:0 12px">${text(item.label)}</a>`).join("")}</div>`;
              break;
            }
            {
              const settings = (0, newsletter_js_1.newsletterSocialSettings)(block), size = newsletterSocialIconSize(settings.desktop.size);
              const share = settings.mode === "share";
              const items = share ? (0, newsletter_social_share_js_1.newsletterSocialShareItems)(block) : block.items;
              content = `<div style="${css};text-align:${style.align || "center"}">${items.map((item, index) => {
                const platform = share ? item.platform || "website" : (0, newsletter_js_1.newsletterSocialPlatform)(item);
                const iconUrl = `${options.publicUrl?.replace(/\/$/, "") || ""}/newsletter/social-${platform}-${settings.iconStyle}.png`;
                const target = block.openNewTab ? ' target="_blank" rel="noopener noreferrer"' : "";
                const icon = settings.display !== "text" ? `<img class="nl-social-icon" src="${newsletterEscape(iconUrl)}" alt="${settings.display === "icon" ? newsletterEscape(item.label || platform) : ""}" width="${size}" height="${size}" style="display:inline-block;vertical-align:middle;width:${size}px;height:${size}px;border:0">` : "";
                const label = settings.display !== "icon" ? `<span class="nl-social-label" style="padding-left:${icon ? 8 : 0}px;vertical-align:middle">${text(item.label || platform)}</span>` : "";
                const last = index === items.length - 1;
                const tag = share && !item.url ? "span" : "a";
                const destination = tag === "a" ? ` href="${link(item.url)}"${target}` : ' aria-disabled="true"';
                return `<table role="presentation" cellpadding="0" cellspacing="0" class="nl-social-item${last ? " nl-social-last" : ""}" style="${socialItemLayout(last ? { ...settings.desktop, spacing: 0 } : settings.desktop, style.align || "center")}"><tr><td style="padding:0;vertical-align:middle"><${tag}${destination} style="${newsletterStyleCss(socialTextStyle(style))};color:${style.color || design.styles.link.color};text-decoration:none">${icon}${label}</${tag}></td></tr></table>`;
              }).join("")}</div>`;
            }
            break;
          case "survey":
            if (block.survey) {
              const url = block.survey.saved ? newsletterSafeUrl(options.savedSurveyUrl?.(block.id) || "") : "";
              const tag = url ? "a" : "span";
              content = `<div style="text-align:${style.align || "center"};padding:12px 0;${block.survey.blockBackground ? `background:${block.survey.blockBackground};` : ""}"><${tag}${url ? ` href="${link(url)}"${block.openNewTab ? ' target="_blank" rel="noopener noreferrer"' : ""}` : ' aria-disabled="true"'} style="display:inline-block;text-decoration:none;${css}">${text(block.text || "Start Survey")}</${tag}></div>`;
              break;
            }
            content = `<div style="${css}"><p>${text(block.question)}</p>${block.options.map((answer) => `<a href="${newsletterEscape(options.surveyUrl?.(block.id, answer) ?? (newsletterSafeUrl(block.url) || "#"))}" style="display:block;padding:10px;margin:6px 0;border:1px solid #777;color:inherit">${text(answer)}</a>`).join("")}</div>`;
            break;
          case "product":
          case "product-rec":
            content = `<table role="presentation" width="100%"><tr>${block.items.map((item) => `<td valign="top" style="padding:8px;width:${100 / Math.max(1, block.items.length)}%;${css}">${item.imageUrl ? image(item.imageUrl, item.label) : ""}<h3>${text(item.label)}</h3><p>${text(item.description ?? "")}</p><p>${text(item.price ?? "")}</p><a href="${link(item.url)}" style="color:inherit">${text(block.text || "Learn more")}</a></td>`).join("")}</tr></table>`;
            break;
          case "columns": {
            const ratio = block.ratio.includes(":") ? block.ratio.split(":").map(Number) : block.columns.map(() => 1);
            const sum = ratio.reduce((a, b) => a + b, 0) || block.columns.length;
            content = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${block.columns.map((column, index) => `<td class="${block.mobileOrientation === "stacked" ? "nl-column" : ""}" valign="top" width="${(ratio[index] ?? 1) / sum * 100}%" style="padding:${index ? "0 0 0 16px" : "0 16px 0 0"};${css}">${column.map((child) => renderNewsletterBlock2(child, design, config, options)).join("")}</td>`).join("")}</tr></table>`;
            break;
          }
          case "footer":
            content = `<div style="${css}"><p>Copyright &copy; ${(/* @__PURE__ */ new Date()).getFullYear()} ${text(config.company || "*|LIST:COMPANY|*")}. All rights reserved.</p><p>${text(config.permissionReminder)}</p><p>Our mailing address is:<br>${text(config.mailingAddress || "*|HTML:LIST_ADDRESS|*")}</p><p>Want to change how you receive these emails?</p><p>You can <a href="${link(options.preferencesUrl ?? "*|UPDATE_PROFILE|*")}" style="color:inherit">update your preferences</a> or <a href="${link(options.unsubscribeUrl ?? "*|UNSUB|*")}" style="color:inherit">unsubscribe</a>.</p></div>`;
            break;
        }
        const spacing = button ? {} : style;
        const savedSurvey = block.kind === "survey" && !!block.survey;
        return `<div id="${newsletterEscape(block.id)}" class="nl-block-${newsletterEscape(block.id)}" style="padding:${savedSurvey ? 0 : spacing.paddingTop ?? 12}px ${spacing.paddingRight ?? 0}px ${savedSurvey ? 0 : spacing.paddingBottom ?? 12}px ${spacing.paddingLeft ?? 0}px;${spacing.margin ? `margin:${spacing.margin}px;` : ""}${block.visibility.mode === "custom" && options.editor ? "opacity:.65;" : ""}">${content}</div>`;
      }
      function renderNewsletterDesign(design, config, options = {}) {
        const styles = design.styles;
        const mobileRules = [];
        const important = (style) => newsletterStyleCss(style).split(";").filter(Boolean).map((rule) => `${rule}!important`).join(";");
        const walk = (blocks) => {
          for (const block of blocks) {
            const button = block.kind === "button" || block.kind === "survey" && !!block.survey;
            if (block.kind === "social" && block.social && !block.linkedStyles) {
              const device = block.social.mobile, size = newsletterSocialIconSize(device.size);
              const alignment = block.mobileStyle.align || block.style.align || "center";
              const css = socialItemLayout(device, alignment).split(";").filter(Boolean).map((value) => `${value}!important`).join(";");
              mobileRules.push(`.nl-block-${block.id} .nl-social-item{${css}}.nl-block-${block.id} .nl-social-last{${device.layout === "horizontal" ? "margin-right:0" : "margin-bottom:0"}!important}.nl-block-${block.id} .nl-social-icon{width:${size}px!important;height:${size}px!important}`);
              const textCss = important(socialTextStyle(block.mobileStyle));
              if (textCss)
                mobileRules.push(`.nl-block-${block.id} .nl-social-item a{${textCss}}`);
            }
            const key = block.kind === "heading" ? `h${block.headingLevel}` : ["paragraph", "apps", "code", "footer"].includes(block.kind) ? "p" : null;
            const global = !styles.linkedStyles ? key ? styles.mobileText[key] : button ? styles.mobileButton : block.kind === "divider" ? styles.mobileDivider : block.kind === "image" ? styles.mobileImage : block.kind === "logo" ? styles.mobileLogo : {} : {};
            const mobile = { ...global, ...!block.linkedStyles ? block.mobileStyle : {} };
            if (block.kind === "apps" && block.app?.showBackground && mobile.color) {
              mobile.color = !block.linkedStyles && block.mobileStyle.color || block.style.color || "#1f2937";
            }
            if (Object.keys(mobile).length) {
              const inner = { ...mobile };
              if (["image", "logo", "video"].includes(block.kind))
                delete inner.width;
              const spacing = {};
              if (!button) {
                for (const key2 of [
                  "paddingTop",
                  "paddingBottom",
                  "paddingLeft",
                  "paddingRight",
                  "margin"
                ]) {
                  if (inner[key2] !== void 0)
                    spacing[key2] = inner[key2];
                  delete inner[key2];
                }
              }
              if (Object.keys(spacing).length)
                mobileRules.push(`.nl-block-${block.id}{${important(spacing)}}`);
              let declarations = important(inner);
              if (block.kind === "divider")
                declarations = declarations.replace(/border-(width|style|color):/g, "border-top-$1:");
              const selector = block.kind === "survey" && block.survey ? `.nl-block-${block.id}>div>a,.nl-block-${block.id}>div>span` : button ? `.nl-block-${block.id}>div>a` : block.kind === "image" ? `.nl-block-${block.id} img` : `.nl-block-${block.id}>*`;
              if (declarations)
                mobileRules.push(`${selector}{${declarations}}`);
              if (block.kind === "survey" && block.survey && mobile.align)
                mobileRules.push(`.nl-block-${block.id}>div{text-align:${mobile.align}!important}`);
              if (["image", "logo"].includes(block.kind) && mobile.align) {
                const alignment = mobile.align === "center" ? "margin-left:auto!important;margin-right:auto!important" : mobile.align === "right" ? "margin-left:auto!important;margin-right:0!important" : "margin-left:0!important;margin-right:auto!important";
                mobileRules.push(`.nl-block-${block.id} img{${alignment}}`);
              }
            }
            for (const column of block.columns)
              walk(column);
          }
        };
        design.sections.forEach((section) => walk(section.blocks));
        const webFonts = (0, newsletter_fonts_js_1.newsletterWebFontUrls)((0, newsletter_fonts_js_1.newsletterDesignFontRequests)(design)).map((url) => `<link rel="stylesheet" href="${newsletterEscape(url)}" referrerpolicy="no-referrer">`).join("");
        return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${newsletterEscape(config.subject || "Weekly newsletter")}</title>${webFonts}<style>${newsletterFontCss((0, newsletter_js_1.newsletterDesignFonts)(design))}body{margin:0}table{border-collapse:collapse}a{color:${styles.link.color ?? "#fff"}}p{margin:0 0 12px}@media(max-width:600px){.nl-shell{width:100%!important}.nl-padding{padding:${styles.mobilePadding}px!important}.nl-column{display:block!important;width:100%!important;padding:0!important}h1{font-size:32px!important}h2{font-size:26px!important}${mobileRules.join("")}}</style></head><body style="background:${styles.background};${styles.backgroundImage ? `background-image:url('${newsletterEscape(newsletterCssUrl(styles.backgroundImage))}');` : ""}"><div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${newsletterEscape(config.previewText)}</div><table role="presentation" width="100%"><tr><td align="center"><table class="nl-shell" role="presentation" width="${styles.width}" style="width:${styles.width}px;max-width:100%;background:${styles.content}"><tr><td class="nl-padding" style="padding:24px">${design.sections.map((section) => `<section id="${newsletterEscape(section.id)}" style="${newsletterStyleCss(section.style)}">${section.blocks.map((block) => renderNewsletterBlock2(block, design, config, options)).join("")}</section>`).join("")}</td></tr></table></td></tr></table></body></html>`;
      }
      function newsletterPlainText(design, config, options = {}) {
        const paragraphs = [];
        const push = (value, literal = false) => paragraphs.push(literal ? value : newsletterMergeText(value, config, options));
        const walk = (blocks) => {
          for (const block of blocks) {
            if (!(0, newsletter_js_1.newsletterBlockVisible)(block, options.recipient))
              continue;
            if (block.kind === "columns")
              block.columns.forEach(walk);
            else if (block.kind === "footer")
              push(`${config.company}
${config.permissionReminder}
${config.mailingAddress}
Update preferences: ${options.preferencesUrl ?? "*|UPDATE_PROFILE|*"}
Unsubscribe: ${options.unsubscribeUrl ?? "*|UNSUB|*"}`);
            else if (block.kind === "apps" && block.app?.sourceUrl) {
              push(`${block.app.title}${block.app.showDescription ? `
${block.app.description}` : ""}
${block.app.sourceUrl}`, true);
            } else if (block.kind === "social" && block.social?.mode === "share") {
              for (const item of (0, newsletter_social_share_js_1.newsletterSocialShareItems)(block))
                if (item.url)
                  push(`${item.label || "Share"}
${item.url}`);
            } else if (block.kind === "video" && block.video) {
              push(`${block.alt || "Watch video"}${block.url ? `
${block.url}` : ""}`);
            } else if (block.kind === "survey" && block.survey) {
              const url = block.survey.saved ? newsletterSafeUrl(options.savedSurveyUrl?.(block.id) || "") : "";
              push(`${block.text || "Start Survey"}${url ? `
${url}` : ""}`);
            } else {
              const text = block.html ? block.html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&") : block.text;
              if (text)
                push(text + (block.url ? `
${block.url}` : ""));
              for (const item of block.items)
                push(`${item.label}
${item.description ?? ""}
${item.url}`);
            }
          }
        };
        design.sections.forEach((section) => walk(section.blocks));
        return paragraphs.join("\n\n");
      }
    }
  });

  // browser-entry.mjs
  var browser_entry_exports = {};
  __export(browser_entry_exports, {
    run: () => run
  });
  var import_newsletter = __toESM(require_newsletter(), 1);
  var import_newsletter_render = __toESM(require_newsletter_render(), 1);
  function run() {
    const html = (0, import_newsletter_render.renderNewsletterBlock)((0, import_newsletter.createNewsletterBlock)("paragraph", { id: "browser", html: "<b>Browser</b>" }), { version: 1, styles: (0, import_newsletter.defaultNewsletterStyles)(), sections: [] }, (0, import_newsletter.defaultNewsletterConfig)());
    return { template: import_newsletter.NEWSLETTER_TEMPLATE_ID, escaped: html.includes("&lt;b&gt;Browser&lt;/b&gt;"), refusedPublicCapability: (0, import_newsletter_render.newsletterSocialShareTarget)("https://example.com/engagement/newsletter-public/token") === "", fontCount: import_newsletter.NEWSLETTER_FONT_CATALOG.length, missingNodeGlobals: typeof process === "undefined" && typeof Buffer === "undefined" && typeof __require === "undefined" };
  }
  return __toCommonJS(browser_entry_exports);
})();
