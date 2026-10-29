/*
 * Apache ECharts region plug-in for Oracle APEX (TechRevX, www.techrevx.com)
 *
 * techrevx.echarts.init( regionId, advancedOptions, initFunction, customTheme ) is called once per region by
 * the plug-in's render procedure. It reads the attribute values and the first data set from the JSON block
 * #<regionId>_data, builds the ECharts option for the chart type, merges the ECharts Options attribute,
 * calls the Initialization JavaScript Function and draws the chart into #<regionId>_chart.
 *
 * apex.region( regionId ).refresh()   re-reads the rows through the plug-in's AJAX callback
 * apex.region( regionId ).getChart()  returns the echarts instance (also techrevx.echarts.get( regionId ))
 * Clicks fire "tx-echarts-click" (Dynamic Action event "ECharts - Click") on the region with
 * { name, value, seriesName, dataIndex, chartType, x, y } and set the Set Item on Click item first.
 *
 * Rows: x (label), v (value), s (series), y (y category or link target), id, p (parent id), sz (size), c (color),
 * o / h / l (candlestick open, high, low).
 * Checkbox attributes arrive as colon-separated lists.
 */
( function( $, apex, echarts ) {
    "use strict";

    const ns = window.techrevx = window.techrevx || {},
        charts = {},
        // ECharts 6 default palette; used where a color is needed before the chart draws (gradient areas)
        DEFAULT_PALETTE = [ "#5070dd", "#b6d634", "#505372", "#ff994d", "#0ca8df", "#ffd10a", "#fb628b", "#785db0", "#3fbe95" ];
    let customThemeRegistered = false;

    // ---------- helpers ----------
    const list = value => value ? String( value ).split( ":" ) : [];
    const has = ( value, flag ) => list( value ).indexOf( flag ) > -1;
    const esc = value => apex.util.escapeHTML( value === null || value === undefined ? "" : String( value ) );
    const str = value => value === null || value === undefined ? "" : String( value );

    function num( value ) {
        const n = typeof value === "number" ? value : parseFloat( value );
        return isNaN( n ) ? null : n;
    }

    // SALES_AMOUNT -> Sales Amount (default series name)
    function prettify( column ) {
        return str( column ).toLowerCase().replace( /_/g, " " ).replace( /\b\w/g, c => c.toUpperCase() );
    }

    function isPlainObject( o ) {
        return o !== null && typeof o === "object" && !Array.isArray( o ) && Object.getPrototypeOf( o ) === Object.prototype;
    }

    // Deep merge of the ECharts Options attribute: objects merge, arrays of objects merge by position,
    // a series object (not an array) merges into every series, anything else replaces.
    function merge( target, source ) {
        Object.keys( source ).forEach( key => {
            const s = source[ key ], t = target[ key ];
            if ( key === "series" && isPlainObject( s ) && Array.isArray( t ) ) {
                t.forEach( series => merge( series, s ) );
            } else if ( Array.isArray( s ) && Array.isArray( t ) && s.every( isPlainObject ) ) {
                s.forEach( ( item, i ) => { t[ i ] = isPlainObject( t[ i ] ) ? merge( t[ i ], item ) : item; } );
            } else if ( isPlainObject( s ) && isPlainObject( t ) ) {
                merge( t, s );
            } else {
                target[ key ] = s;
            }
        } );
        return target;
    }

    function alpha( color, a ) {
        let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec( str( color ).trim() );
        if ( m ) {
            let hex = m[ 1 ];
            if ( hex.length === 3 ) { hex = hex.replace( /./g, "$&$&" ); }
            return "rgba(" + parseInt( hex.substr( 0, 2 ), 16 ) + "," + parseInt( hex.substr( 2, 2 ), 16 ) + "," + parseInt( hex.substr( 4, 2 ), 16 ) + "," + a + ")";
        }
        m = /^rgba?\(([^)]+)\)$/i.exec( str( color ).trim() );
        if ( m ) {
            return "rgba(" + m[ 1 ].split( "," ).slice( 0, 3 ).join( "," ) + "," + a + ")";
        }
        return color;
    }

    // light text color means the page uses a dark theme style
    function pageIsDark( el ) {
        const c = ( getComputedStyle( el ).color.match( /\d+(\.\d+)?/g ) || [] ).map( Number );
        return c.length >= 3 && ( 0.299 * c[ 0 ] + 0.587 * c[ 1 ] + 0.114 * c[ 2 ] ) > 150;
    }

    function language() {
        return ( apex.locale && apex.locale.getLanguage && apex.locale.getLanguage() ) || undefined;
    }

    // APEX trims attribute values, so a word suffix ("kg", "orders") gets its space back here; "%" or "k" stay attached
    function suffixOf( cfg ) {
        const s = cfg.valueSuffix || "";
        return /^\p{L}{2,}/u.test( s ) ? " " + s : s;
    }

    // value formatter: Oracle format mask (apex.locale) or locale grouping, plus the suffix (pass noSuffix for bare numbers)
    function makeFormatter( cfg, noSuffix ) {
        const lang = language(), suffix = noSuffix ? "" : suffixOf( cfg );
        return value => {
            const n = num( value );
            let text;
            if ( value === null || value === undefined || value === "" ) { return "-"; }
            if ( n === null ) { return str( value ); }
            if ( cfg.valueFormat ) {
                try {
                    text = apex.locale.formatNumber( n, cfg.valueFormat ).trim();
                } catch ( e ) {
                    text = null;
                }
            }
            if ( !text || /^#+$/.test( text ) ) {
                text = n.toLocaleString( lang, { maximumFractionDigits: 2 } );
            }
            return text + suffix;
        };
    }

    // axis labels keep short suffixes (%, k, h) and drop words to save room
    function axisFormatter( cfg ) {
        return makeFormatter( cfg, suffixOf( cfg ).length > 2 );
    }

    function axisLimit( value ) {
        const v = str( value ).trim();
        if ( !v ) { return undefined; }
        if ( v === "dataMin" || v === "dataMax" ) { return v; }
        return num( v ) === null ? undefined : num( v );
    }

    function formatDate( iso ) {
        const d = new Date( str( iso ).substr( 0, 10 ) + "T00:00:00" );
        return isNaN( d ) ? str( iso ) : d.toLocaleDateString( language(), { year: "numeric", month: "short", day: "numeric" } );
    }

    // ---------- layout ----------
    function titleHeight( cfg ) {
        return cfg.title ? ( cfg.subtitle ? 58 : 38 ) : 0;
    }

    function legendFor( cfg, names ) {
        const pos = cfg.legendPosition || "bottom",
            vertical = pos === "left" || pos === "right",
            legend = { type: cfg.legendType || "scroll", orient: vertical ? "vertical" : "horizontal", data: names };
        if ( pos === "top" ) {
            legend.top = titleHeight( cfg ) + ( cfg.toolbox && !cfg.title ? 28 : 0 );
            legend.left = "center";
        } else if ( pos === "bottom" ) {
            legend.bottom = 4;
            legend.left = "center";
        } else {
            legend[ pos ] = 8;
            legend.top = "middle";
        }
        return legend;
    }

    // plot area for the axis charts, leaving room for title, legend, toolbox, slider, axis titles and scale
    function gridFor( cfg, ctx ) {
        const pos = cfg.legendPosition || "bottom";
        let top = titleHeight( cfg ) + 14, bottom = 8, left = 12, right = 20;
        if ( cfg.toolbox && !cfg.title ) { top += 28; }
        if ( ctx.legend && pos === "top" ) { top += 30; }
        if ( ctx.legend && pos === "bottom" ) { bottom += 30; }
        if ( ctx.legend && pos === "left" ) { left += 130; }
        if ( ctx.legend && pos === "right" ) { right += 130; }
        if ( ctx.yTitle ) { top += 22; }
        if ( ctx.xTitle ) { bottom += 26 + Math.round( Math.abs( cfg.xLabelRotate || 0 ) / 90 * 40 ); }
        if ( ctx.slider ) { if ( ctx.horizontal ) { right += 44; } else { bottom += 44; } }
        if ( ctx.scale ) { bottom += 66; }
        right += ctx.rightExtra || 0;
        return { top, bottom, left, right, containLabel: true };
    }

    function toolboxFor( cfg, type ) {
        const t = cfg.toolbox, feature = {};
        if ( !t ) { return undefined; }
        if ( has( t, "dataZoom" ) && [ "line", "bar", "scatter", "heatmap" ].indexOf( type ) > -1 ) {
            feature.dataZoom = type === "scatter" ? {} : { yAxisIndex: "none" };
        }
        if ( has( t, "magicType" ) && ( type === "line" || type === "bar" ) ) {
            feature.magicType = { type: [ "line", "bar", "stack" ] };
        }
        if ( has( t, "dataView" ) ) { feature.dataView = { readOnly: true }; }
        if ( has( t, "restore" ) ) { feature.restore = {}; }
        if ( has( t, "saveAsImage" ) ) { feature.saveAsImage = { name: cfg.title || cfg.regionId, pixelRatio: 2 }; }
        return { right: 8, top: 4, feature };
    }

    function visualMapFor( cfg, min, max, fmt, ints ) {
        const so = cfg.scaleOptions,
            vm = {
                min: isFinite( min ) ? min : 0,
                max: isFinite( max ) ? max : 1,
                orient: "horizontal",
                left: "center",
                bottom: 4,
                show: !has( so, "hide" ),
                inRange: { color: [ cfg.minColor || "#e3e8fb", cfg.maxColor || "#3442a8" ] }
            };
        if ( vm.min === vm.max ) { vm.max = vm.min + 1; }
        if ( has( so, "piecewise" ) ) {
            const bare = makeFormatter( cfg, true );
            vm.type = "piecewise";
            vm.splitNumber = 5;
            vm.formatter = ( a, b ) => a === b ? fmt( a ) : bare( a ) + " - " + fmt( b );
            // whole-number data gets five whole-number bands
            if ( ints ) {
                const step = Math.max( 1, Math.ceil( ( vm.max - vm.min + 1 ) / 5 ) );
                vm.pieces = [];
                for ( let a = vm.min; a <= vm.max; a += step ) {
                    vm.pieces.push( { min: a, max: Math.min( a + step - 1, vm.max ) } );
                }
            }
        } else {
            vm.type = "continuous";
            vm.calculable = has( so, "handles" );
            vm.formatter = v => fmt( v );
        }
        return vm;
    }

    // ---------- data shaping ----------
    // categories in row order and, per series, the summed value and color of each category
    function categoryData( rows, cfg ) {
        const cats = [], seen = new Set(), series = new Map(), defaultName = prettify( cfg.valueColumn ) || "Value";
        rows.forEach( r => {
            const c = str( r.x ), s = r.s === undefined || r.s === null ? defaultName : String( r.s ), v = num( r.v );
            if ( !seen.has( c ) ) { seen.add( c ); cats.push( c ); }
            if ( !series.has( s ) ) { series.set( s, { values: new Map(), colors: new Map() } ); }
            const entry = series.get( s );
            if ( v !== null ) {
                entry.values.set( c, ( entry.values.get( c ) || 0 ) + v );
            } else if ( !entry.values.has( c ) ) {
                entry.values.set( c, null );
            }
            if ( r.c ) { entry.colors.set( c, r.c ); }
        } );
        return { cats, series };
    }

    // nodes from id / parent id rows; rows without ids form a flat list. Cycles are cut so every node is reachable.
    function hierarchy( rows ) {
        const node = r => {
            const n = { name: str( r.x ) }, v = num( r.v );
            if ( v !== null ) { n.value = v; }
            if ( r.c ) { n.itemStyle = { color: r.c }; }
            return n;
        };
        if ( !rows.some( r => r.id !== undefined && r.id !== null ) ) {
            return rows.map( node );
        }
        const nodes = new Map(), parent = new Map(), roots = [];
        rows.forEach( r => nodes.set( str( r.id ), node( r ) ) );
        rows.forEach( r => {
            const id = str( r.id ), n = nodes.get( id ), pid = r.p === undefined || r.p === null ? null : str( r.p );
            if ( pid !== null && pid !== id && nodes.has( pid ) ) {
                const p = nodes.get( pid );
                ( p.children = p.children || [] ).push( n );
                parent.set( n, p );
            } else if ( roots.indexOf( n ) < 0 ) {
                roots.push( n );
            }
        } );
        const visited = new Set();
        const visit = n => { if ( visited.has( n ) ) { return; } visited.add( n ); ( n.children || [] ).forEach( visit ); };
        roots.forEach( visit );
        nodes.forEach( n => {
            if ( !visited.has( n ) ) {
                const p = parent.get( n );
                p.children.splice( p.children.indexOf( n ), 1 );
                roots.push( n );
                visit( n );
            }
        } );
        return roots;
    }

    // ---------- chart types ----------
    function buildAxisChart( cfg, rows, option, fmt, type, palette ) {
        const f = cfg.features, ax = cfg.axisOptions,
            opts = type === "line" ? cfg.lineOptions : cfg.barOptions,
            horizontal = type === "bar" && has( opts, "horizontal" ),
            time = has( ax, "time" ),
            percent = has( opts, "percent" ),
            stack = percent || has( opts, "stack" ),
            area = type === "line" && ( has( opts, "area" ) || has( opts, "gradient" ) ),
            labels = has( f, "labels" ),
            d = categoryData( rows, cfg ),
            names = [];
        let cats = d.cats;

        if ( type === "bar" && has( opts, "sort" ) ) {
            const total = c => { let t = 0; d.series.forEach( e => { t += e.values.get( c ) || 0; } ); return t; };
            cats = cats.slice().sort( ( a, b ) => total( b ) - total( a ) );
        }
        const totals = percent ? cats.map( c => { let t = 0; d.series.forEach( e => { t += Math.abs( e.values.get( c ) || 0 ); } ); return t; } ) : null;
        const pct = v => num( v ) === null ? "-" : num( v ).toFixed( 1 ) + "%";
        const valueFmt = percent ? pct : fmt;
        const pointValue = p => Array.isArray( p.value ) ? p.value[ 1 ] : p.value;

        let i = 0;
        d.series.forEach( ( entry, name ) => {
            names.push( name );
            const data = cats.map( ( c, ci ) => {
                const raw = entry.values.has( c ) ? entry.values.get( c ) : null,
                    value = percent ? ( raw === null || !totals[ ci ] ? null : raw / totals[ ci ] * 100 ) : raw,
                    color = entry.colors.get( c );
                if ( !percent && !color ) { return time ? [ c, value ] : value; }
                const item = { value: time ? [ c, value ] : value };
                if ( percent ) { item.raw = raw; }
                if ( color ) { item.itemStyle = { color }; }
                return item;
            } );
            const s = { type, name, data, emphasis: { focus: "series" } };
            if ( stack ) { s.stack = "total"; }
            if ( labels ) {
                s.label = { show: true, position: cfg.labelPosition || ( stack ? "inside" : horizontal ? "right" : "top" ), formatter: p => valueFmt( pointValue( p ) ) };
            }
            if ( type === "line" ) {
                s.smooth = has( opts, "smooth" );
                if ( has( opts, "step" ) ) { s.step = "middle"; }
                s.showSymbol = has( opts, "symbols" );
                if ( cfg.symbol ) { s.symbol = cfg.symbol; }
                if ( cfg.symbolSize ) { s.symbolSize = cfg.symbolSize; }
                s.connectNulls = has( opts, "connectNulls" );
                if ( area ) {
                    const color = palette[ i % palette.length ];
                    s.areaStyle = has( opts, "gradient" )
                        ? { opacity: 1, color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [ { offset: 0, color: alpha( color, 0.45 ) }, { offset: 1, color: alpha( color, 0.02 ) } ] } }
                        : { opacity: 0.25 };
                }
                if ( has( opts, "endLabel" ) ) { s.endLabel = { show: true, formatter: "{a}" }; }
            } else {
                if ( cfg.barWidth ) { s.barWidth = /%\s*$/.test( cfg.barWidth ) ? cfg.barWidth.trim() : num( cfg.barWidth ); }
                if ( has( opts, "rounded" ) ) { s.itemStyle = { borderRadius: stack ? 3 : horizontal ? [ 0, 6, 6, 0 ] : [ 6, 6, 0, 0 ] }; }
                if ( has( opts, "background" ) ) { s.showBackground = true; }
            }
            const points = [];
            if ( has( opts, "markMax" ) ) { points.push( { type: "max", name: "Maximum" } ); }
            if ( has( opts, "markMin" ) ) { points.push( { type: "min", name: "Minimum" } ); }
            if ( points.length ) { s.markPoint = { data: points, label: { formatter: p => valueFmt( p.value ) } }; }
            if ( has( opts, "markAverage" ) ) {
                s.markLine = { symbol: [ "none", "none" ], data: [ { type: "average", name: "Average" } ], label: { formatter: p => valueFmt( p.value ) } };
            }
            option.series.push( s );
            i++;
        } );

        const catAxis = {
                type: time ? "time" : "category",
                data: time ? undefined : cats,
                boundaryGap: type === "bar" || !area,
                inverse: horizontal,
                axisTick: { alignWithLabel: true },
                axisLabel: { rotate: cfg.xLabelRotate || 0, hideOverlap: true }
            },
            valAxis = {
                type: has( ax, "log" ) ? "log" : "value",
                scale: has( ax, "scale" ),
                inverse: has( ax, "inverse" ),
                min: percent ? 0 : axisLimit( cfg.yAxisMin ),
                max: percent ? 100 : axisLimit( cfg.yAxisMax ),
                splitLine: { show: has( ax, "gridLines" ) },
                axisLabel: { formatter: percent ? pct : axisFormatter( cfg ) }
            },
            xAxis = horizontal ? valAxis : catAxis,
            yAxis = horizontal ? catAxis : valAxis;
        if ( cfg.xAxisTitle ) {
            Object.assign( xAxis, { name: cfg.xAxisTitle, nameLocation: "middle", nameGap: 32 + Math.round( Math.abs( cfg.xLabelRotate || 0 ) / 90 * 40 ) } );
        }
        if ( cfg.yAxisTitle ) {
            Object.assign( yAxis, { name: cfg.yAxisTitle, nameLocation: "end", nameTextStyle: { align: "left" } } );
        }
        option.xAxis = xAxis;
        option.yAxis = yAxis;

        if ( option.tooltip ) {
            option.tooltip.trigger = "axis";
            option.tooltip.axisPointer = { type: type === "bar" ? "shadow" : "line" };
            if ( percent ) {
                option.tooltip.formatter = params => esc( params[ 0 ].axisValueLabel ) + params.map( p =>
                    "<br>" + p.marker + esc( p.seriesName ) + ": <b>" + esc( fmt( p.data && p.data.raw ) ) + "</b> (" + pct( pointValue( p ) ) + ")" ).join( "" );
            }
        }
        const zoomAxis = horizontal ? "yAxisIndex" : "xAxisIndex", zoom = [];
        if ( has( f, "zoomInside" ) ) { zoom.push( { type: "inside", [ zoomAxis ]: 0 } ); }
        if ( has( f, "zoomSlider" ) ) {
            zoom.push( Object.assign( { type: "slider", [ zoomAxis ]: 0 }, horizontal ? { right: 8 } : { bottom: has( f, "legend" ) && ( cfg.legendPosition || "bottom" ) === "bottom" && names.length > 1 ? 36 : 8 } ) );
        }
        if ( zoom.length ) { option.dataZoom = zoom; }

        // average line labels, end labels and value labels beside horizontal bars sit outside the plot area
        const rightExtra = ( has( opts, "markAverage" ) && !horizontal ) || has( opts, "endLabel" ) ? 64 : horizontal && labels ? 64 : 0;
        return { names, ctx: { horizontal, xTitle: !!cfg.xAxisTitle, yTitle: !!cfg.yAxisTitle, slider: has( f, "zoomSlider" ), rightExtra } };
    }

    function buildScatter( cfg, rows, option, fmt ) {
        const f = cfg.features, so = cfg.scatterOptions, ax = cfg.axisOptions,
            groups = new Map(),
            defaultName = prettify( cfg.valueColumn ) || "Value",
            xNumeric = rows.every( r => r.x === null || r.x === undefined || num( r.x ) !== null ),
            maxSize = rows.reduce( ( m, r ) => Math.max( m, Math.abs( num( r.sz ) || 0 ) ), 0 ),
            biggest = cfg.symbolSize || ( maxSize ? 48 : 10 ),
            lang = language(),
            xText = v => typeof v === "number" ? v.toLocaleString( lang, { maximumFractionDigits: 2 } ) : str( v );

        rows.forEach( r => {
            const name = r.s === undefined || r.s === null ? defaultName : String( r.s ),
                point = [ xNumeric ? num( r.x ) : str( r.x ), num( r.v ) ];
            if ( maxSize ) { point.push( num( r.sz ) ); }
            if ( !groups.has( name ) ) { groups.set( name, [] ); }
            groups.get( name ).push( r.c ? { value: point, itemStyle: { color: r.c } } : point );
        } );
        groups.forEach( ( data, name ) => {
            const s = { type: has( so, "ripple" ) ? "effectScatter" : "scatter", name, data, emphasis: { focus: "series" } };
            if ( cfg.symbol ) { s.symbol = cfg.symbol; }
            s.symbolSize = maxSize ? v => Math.max( 4, Math.sqrt( Math.abs( v[ 2 ] || 0 ) / maxSize ) * biggest ) : biggest;
            if ( has( so, "large" ) ) { s.large = true; s.largeThreshold = 2000; }
            if ( has( f, "labels" ) ) { s.label = { show: true, position: cfg.labelPosition || "top", formatter: p => fmt( p.value[ 1 ] ) }; }
            option.series.push( s );
        } );
        option.xAxis = { type: xNumeric ? "value" : "category", scale: true, splitLine: { show: has( ax, "gridLines" ) }, axisLabel: { rotate: cfg.xLabelRotate || 0, hideOverlap: true } };
        option.yAxis = {
            type: has( ax, "log" ) ? "log" : "value",
            scale: has( ax, "scale" ),
            inverse: has( ax, "inverse" ),
            min: axisLimit( cfg.yAxisMin ),
            max: axisLimit( cfg.yAxisMax ),
            splitLine: { show: has( ax, "gridLines" ) },
            axisLabel: { formatter: axisFormatter( cfg ) }
        };
        if ( cfg.xAxisTitle ) { Object.assign( option.xAxis, { name: cfg.xAxisTitle, nameLocation: "middle", nameGap: 32 } ); }
        if ( cfg.yAxisTitle ) { Object.assign( option.yAxis, { name: cfg.yAxisTitle, nameLocation: "end", nameTextStyle: { align: "left" } } ); }
        if ( option.tooltip ) {
            option.tooltip.trigger = "item";
            option.tooltip.formatter = p => {
                const v = p.value;
                return p.marker + esc( p.seriesName ) +
                    "<br>" + esc( cfg.xAxisTitle || "X" ) + ": <b>" + esc( xText( v[ 0 ] ) ) + "</b>" +
                    "<br>" + esc( cfg.yAxisTitle || "Y" ) + ": <b>" + esc( fmt( v[ 1 ] ) ) + "</b>" +
                    ( maxSize ? "<br>" + esc( prettify( cfg.sizeColumn ) || "Size" ) + ": <b>" + esc( xText( v[ 2 ] ) ) + "</b>" : "" );
            };
        }
        const zoom = [];
        if ( has( f, "zoomInside" ) ) { zoom.push( { type: "inside", xAxisIndex: 0 }, { type: "inside", yAxisIndex: 0 } ); }
        if ( has( f, "zoomSlider" ) ) { zoom.push( { type: "slider", xAxisIndex: 0, bottom: 8 } ); }
        if ( zoom.length ) { option.dataZoom = zoom; }
        return { names: Array.from( groups.keys() ), ctx: { xTitle: !!cfg.xAxisTitle, yTitle: !!cfg.yAxisTitle, slider: has( f, "zoomSlider" ) } };
    }

    function buildPie( cfg, rows, option, fmt, dark ) {
        const po = cfg.pieOptions, f = cfg.features, map = new Map();
        rows.forEach( r => {
            const name = str( r.x ), e = map.get( name ) || { name, value: 0 };
            e.value += num( r.v ) || 0;
            if ( r.c ) { e.itemStyle = { color: r.c }; }
            map.set( name, e );
        } );
        const data = Array.from( map.values() ),
            half = has( po, "half" ),
            donut = has( po, "donut" ) || half || has( po, "total" ),
            legendOn = has( f, "legend" ),
            pos = cfg.legendPosition || "bottom",
            th = titleHeight( cfg );
        // outside labels and a side legend both need room, so the pie shrinks for them
        const outside = has( f, "labels" ) && ( !cfg.labelPosition || cfg.labelPosition === "outside" ),
            side = legendOn && ( pos === "left" || pos === "right" ),
            outer = outside ? ( side ? "46%" : "60%" ) : "70%";
        let radius = cfg.pieRadius ? cfg.pieRadius.split( "," ).map( v => v.trim() ).filter( Boolean ) : donut ? [ outside ? "30%" : "45%", outer ] : [ "0%", outer ];
        if ( radius.length === 1 ) { radius = [ "0%", radius[ 0 ] ]; }
        let center = [ "50%", th ? "54%" : "50%" ];
        if ( legendOn && pos === "left" ) { center = [ "58%", center[ 1 ] ]; }
        if ( legendOn && pos === "right" ) { center = [ "42%", center[ 1 ] ]; }
        if ( legendOn && pos === "bottom" ) { center = [ "50%", th ? "50%" : "46%" ]; }
        if ( legendOn && pos === "top" ) { center = [ "50%", th ? "58%" : "54%" ]; }
        if ( half ) {
            center = [ center[ 0 ], "70%" ];
            if ( !cfg.pieRadius ) { radius = outside ? [ "40%", "68%" ] : [ "55%", "95%" ]; }
        }
        const s = {
            type: "pie",
            name: cfg.title || prettify( cfg.valueColumn ) || "Value",
            data,
            radius,
            center,
            avoidLabelOverlap: true,
            emphasis: { scale: true, scaleSize: 6, label: { show: true, fontWeight: "bold" } },
            label: {
                show: has( f, "labels" ),
                position: cfg.labelPosition || "outside",
                formatter: p => p.name + ( has( po, "percent" ) ? ": " + p.percent + "%" : ": " + fmt( p.value ) )
            }
        };
        if ( has( po, "rose" ) ) { s.roseType = "radius"; }
        if ( half ) { s.startAngle = 180; s.endAngle = 360; }
        if ( has( po, "gaps" ) ) { s.padAngle = 2; }
        if ( has( po, "rounded" ) ) { s.itemStyle = { borderRadius: 8 }; }
        if ( has( po, "select" ) ) { s.selectedMode = "single"; s.selectedOffset = 10; }
        option.series.push( s );
        if ( has( po, "total" ) ) {
            // the total is the centered label of an invisible pie filling the hole, so it follows the real pie's center
            const total = data.reduce( ( t, e ) => t + e.value, 0 );
            option.series.push( {
                type: "pie",
                name: "",
                silent: true,
                center,
                radius: [ 0, radius[ 0 ] ],
                data: [ { value: 1, name: "" } ],
                itemStyle: { color: "transparent" },
                label: { show: true, position: "center", formatter: () => fmt( total ), fontSize: 20, fontWeight: "bold", color: dark ? "#eef0f6" : "#1f2333" },
                labelLine: { show: false },
                tooltip: { show: false },
                emphasis: { disabled: true },
                animation: false
            } );
        }
        if ( option.tooltip ) {
            option.tooltip.trigger = "item";
            option.tooltip.formatter = p => p.marker + esc( p.name ) + ": <b>" + esc( fmt( p.value ) ) + "</b> (" + p.percent + "%)";
        }
        return { names: data.map( e => e.name ), ctx: {}, alwaysLegend: true };
    }

    function buildHeatmap( cfg, rows, option, fmt ) {
        const xs = [], ys = [], xi = new Map(), yi = new Map(), cells = new Map(), f = cfg.features;
        rows.forEach( r => {
            const x = str( r.x ), y = str( r.y );
            if ( !xi.has( x ) ) { xi.set( x, xs.length ); xs.push( x ); }
            if ( !yi.has( y ) ) { yi.set( y, ys.length ); ys.push( y ); }
            const key = xi.get( x ) + ":" + yi.get( y );
            cells.set( key, ( cells.get( key ) || 0 ) + ( num( r.v ) || 0 ) );
        } );
        const data = [];
        let min = Infinity, max = -Infinity;
        cells.forEach( ( v, key ) => {
            const parts = key.split( ":" ).map( Number );
            data.push( [ parts[ 0 ], parts[ 1 ], v ] );
            min = Math.min( min, v );
            max = Math.max( max, v );
        } );
        option.xAxis = { type: "category", data: xs, splitArea: { show: true }, axisLabel: { rotate: cfg.xLabelRotate || 0, hideOverlap: true } };
        option.yAxis = { type: "category", data: ys, splitArea: { show: true } };
        if ( cfg.xAxisTitle ) { Object.assign( option.xAxis, { name: cfg.xAxisTitle, nameLocation: "middle", nameGap: 32 } ); }
        if ( cfg.yAxisTitle ) { Object.assign( option.yAxis, { name: cfg.yAxisTitle, nameLocation: "end", nameTextStyle: { align: "left" } } ); }
        option.visualMap = visualMapFor( cfg, min, max, fmt, data.every( c => Number.isInteger( c[ 2 ] ) ) );
        option.series.push( {
            type: "heatmap",
            name: prettify( cfg.valueColumn ) || "Value",
            data,
            label: { show: has( f, "labels" ), formatter: p => fmt( p.value[ 2 ] ) },
            emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(0, 0, 0, 0.4)" } }
        } );
        if ( option.tooltip ) {
            option.tooltip.trigger = "item";
            option.tooltip.formatter = p => esc( xs[ p.value[ 0 ] ] ) + " / " + esc( ys[ p.value[ 1 ] ] ) + ": <b>" + esc( fmt( p.value[ 2 ] ) ) + "</b>";
        }
        const zoom = [];
        if ( has( f, "zoomInside" ) ) { zoom.push( { type: "inside", xAxisIndex: 0 } ); }
        if ( has( f, "zoomSlider" ) ) { zoom.push( { type: "slider", xAxisIndex: 0, bottom: option.visualMap.show ? 60 : 8 } ); }
        if ( zoom.length ) { option.dataZoom = zoom; }
        return { names: [], ctx: { xTitle: !!cfg.xAxisTitle, yTitle: !!cfg.yAxisTitle, slider: has( f, "zoomSlider" ), scale: option.visualMap.show }, xs, ys };
    }

    function buildTree( cfg, rows, option, fmt ) {
        const roots = hierarchy( rows ),
            root = roots.length === 1 ? roots[ 0 ] : { name: cfg.title || "All", children: roots },
            to = cfg.treeOptions,
            layout = ( cfg.treeLayout || "lr" ).toUpperCase(),
            labels = has( cfg.features, "labels" ),
            th = titleHeight( cfg ),
            text = p => p.name + ( labels && p.value !== undefined && p.value !== null && p.value !== "" ? " (" + fmt( p.value ) + ")" : "" ),
            s = {
                type: "tree",
                data: [ root ],
                layout: layout === "RADIAL" ? "radial" : "orthogonal",
                symbol: cfg.symbol || "emptyCircle",
                symbolSize: cfg.symbolSize || 8,
                edgeShape: has( to, "curved" ) ? "curve" : "polyline",
                initialTreeDepth: cfg.treeDepth === null || cfg.treeDepth === undefined ? 2 : cfg.treeDepth,
                expandAndCollapse: has( to, "expand" ),
                roam: has( to, "roam" ),
                emphasis: { focus: "descendant" },
                label: { formatter: text },
                animationDuration: 550,
                animationDurationUpdate: 750
            },
            sides = {
                LR: [ { position: "left", verticalAlign: "middle", align: "right" }, { position: "right", verticalAlign: "middle", align: "left" }, { top: th + 20, bottom: 20, left: "14%", right: "20%" } ],
                RL: [ { position: "right", verticalAlign: "middle", align: "left" }, { position: "left", verticalAlign: "middle", align: "right" }, { top: th + 20, bottom: 20, left: "20%", right: "14%" } ],
                TB: [ { position: "top", rotate: -90, verticalAlign: "middle", align: "right" }, { position: "bottom", rotate: -90, verticalAlign: "middle", align: "left" }, { top: th + 70, bottom: 110, left: 30, right: 30 } ],
                BT: [ { position: "bottom", rotate: 90, verticalAlign: "middle", align: "right" }, { position: "top", rotate: 90, verticalAlign: "middle", align: "left" }, { top: th + 110, bottom: 70, left: 30, right: 30 } ]
            };
        if ( layout === "RADIAL" ) {
            // leaf labels point outwards; keep them inside the region
            Object.assign( s, { top: th + 90, bottom: 90, left: 90, right: 90 } );
        } else {
            s.orient = layout;
            Object.assign( s.label, sides[ layout ][ 0 ] );
            s.leaves = { label: Object.assign( { formatter: text }, sides[ layout ][ 1 ] ) };
            Object.assign( s, sides[ layout ][ 2 ] );
        }
        option.series.push( s );
        if ( option.tooltip ) {
            option.tooltip.trigger = "item";
            option.tooltip.triggerOn = "mousemove";
            option.tooltip.formatter = p => esc( p.name ) + ( p.value !== undefined && p.value !== null && p.value !== "" ? ": <b>" + esc( fmt( p.value ) ) + "</b>" : "" );
        }
        return { names: [], ctx: {} };
    }

    function buildTreemap( cfg, rows, option, fmt, dark ) {
        const tm = cfg.treemapOptions, labels = has( cfg.features, "labels" ), crumb = has( tm, "breadcrumb" ),
            s = {
                type: "treemap",
                name: cfg.title || "All",
                data: hierarchy( rows ),
                roam: has( tm, "roam" ),
                nodeClick: has( tm, "zoom" ) ? "zoomToNode" : false,
                breadcrumb: { show: crumb, bottom: 4 },
                upperLabel: { show: has( tm, "upperLabels" ), height: 24, formatter: p => p.name + ( labels ? "  " + fmt( p.value ) : "" ) },
                label: { show: true, formatter: p => p.name + ( labels ? "\n" + fmt( p.value ) : "" ) },
                itemStyle: { borderColor: dark ? "#18181c" : "#fff" },
                top: titleHeight( cfg ) + ( cfg.toolbox && !cfg.title ? 32 : 8 ),
                bottom: crumb ? 36 : 8,
                left: 8,
                right: 8,
                // levels[ 0 ] is the hidden root: no header strip for it
                levels: has( tm, "saturation" )
                    ? [ { itemStyle: { borderWidth: 0, gapWidth: 4 }, upperLabel: { show: false } },
                        { itemStyle: { gapWidth: 2 }, colorSaturation: [ 0.35, 0.6 ] },
                        { itemStyle: { gapWidth: 1, borderColorSaturation: 0.6 }, colorSaturation: [ 0.3, 0.55 ] } ]
                    : [ { itemStyle: { gapWidth: 3 }, upperLabel: { show: false } }, { itemStyle: { gapWidth: 1 } } ]
            };
        if ( cfg.treemapDepth ) { s.leafDepth = cfg.treemapDepth; }
        option.series.push( s );
        if ( option.tooltip ) {
            option.tooltip.trigger = "item";
            option.tooltip.formatter = p => {
                const path = ( p.treePathInfo || [] ).slice( 1 ).map( n => esc( n.name ) ).join( " / " ) || esc( p.name );
                return path + ": <b>" + esc( fmt( p.value ) ) + "</b>";
            };
        }
        return { names: [], ctx: {} };
    }

    // weeks covered by a calendar range ("2026", "2026-03" or [ start, end ])
    function rangeWeeks( range ) {
        let start, end;
        if ( Array.isArray( range ) ) {
            start = new Date( range[ 0 ] );
            end = new Date( range[ 1 ] );
        } else if ( /^\d{4}$/.test( range ) ) {
            start = new Date( range + "-01-01" );
            end = new Date( range + "-12-31" );
        } else {
            start = new Date( range + "-01" );
            end = new Date( start.getFullYear(), start.getMonth() + 1, 0 );
        }
        const days = Math.max( 1, Math.round( ( end - start ) / 86400000 ) + 1 );
        return isNaN( days ) ? 53 : Math.ceil( ( days + 6 ) / 7 ) + 1;
    }

    function buildCalendar( cfg, rows, option, fmt, dark, el ) {
        const co = cfg.calendarOptions, values = new Map(), lang = language();
        rows.forEach( r => {
            if ( !r.x ) { return; }
            const day = str( r.x ).substr( 0, 10 );
            values.set( day, ( values.get( day ) || 0 ) + ( num( r.v ) || 0 ) );
        } );
        const dates = Array.from( values.keys() ).sort();
        let ranges;
        if ( cfg.calendarRange ) {
            const parts = cfg.calendarRange.split( "," ).map( v => v.trim() ).filter( Boolean );
            ranges = [ parts.length > 1 ? parts : parts[ 0 ] ];
        } else {
            const years = Array.from( new Set( dates.map( d => d.substr( 0, 4 ) ) ) );
            ranges = years.length > 1 ? years : [ dates.length ? [ dates[ 0 ], dates[ dates.length - 1 ] ] : String( new Date().getFullYear() ) ];
        }
        const vertical = has( co, "vertical" ),
            bubbles = has( co, "bubbles" ),
            th = titleHeight( cfg ) + ( cfg.toolbox && !cfg.title ? 30 : 0 ),
            scaleShown = !has( cfg.scaleOptions, "hide" ),
            weeks = Math.max.apply( null, ranges.map( rangeWeeks ) ),
            width = el.clientWidth || 800,
            month = new Intl.DateTimeFormat( lang, { month: "short" } ),
            weekday = new Intl.DateTimeFormat( lang, { weekday: "narrow" } ),
            monthNames = Array.from( { length: 12 }, ( x, i ) => month.format( new Date( 2026, i, 1 ) ) ),
            dayNames = Array.from( { length: 7 }, ( x, i ) => weekday.format( new Date( 2026, 1, 1 + i ) ) ); // 1 Feb 2026 is a Sunday
        let cell = cfg.cellSize;
        if ( !cell ) {
            cell = vertical ? 22 : Math.max( 8, Math.min( 40, Math.floor( ( width - 90 ) / weeks ) ) );
        }
        const block = vertical ? 7 * cell + 70 : 7 * cell + 46,
            first = th + 34;
        option.calendar = ranges.map( ( range, i ) => ( {
            range,
            orient: vertical ? "vertical" : "horizontal",
            cellSize: [ cell, cell ],
            top: vertical ? first : first + i * block,
            left: vertical ? 50 + i * block : 60,
            yearLabel: { show: has( co, "yearLabel" ) },
            // small cells get smaller labels
            dayLabel: { firstDay: has( co, "mondayFirst" ) ? 1 : 0, nameMap: dayNames, fontSize: Math.min( 12, Math.max( 8, cell - 2 ) ) },
            monthLabel: { nameMap: monthNames, fontSize: Math.min( 12, Math.max( 9, cell ) ) },
            splitLine: { show: has( co, "monthLines" ), lineStyle: { color: dark ? "#6b6f80" : "#9aa0b4", width: 1.5 } },
            itemStyle: { borderWidth: 1, borderColor: dark ? "#18181c" : "#fff", color: dark ? "#25262d" : "#f2f3f8" }
        } ) );
        let max = 0, min = Infinity;
        values.forEach( v => { max = Math.max( max, v ); min = Math.min( min, v ); } );
        option.series = option.calendar.map( ( c, i ) => {
            const inRange = d => ranges.length > 1 ? d.substr( 0, 4 ) === c.range : true,
                data = dates.filter( inRange ).map( d => [ d, values.get( d ) ] );
            return bubbles
                ? { type: "scatter", coordinateSystem: "calendar", calendarIndex: i, data, symbolSize: v => Math.max( 3, Math.sqrt( Math.abs( v[ 1 ] || 0 ) / ( max || 1 ) ) * cell * 0.95 ) }
                : { type: "heatmap", coordinateSystem: "calendar", calendarIndex: i, data, label: { show: has( cfg.features, "labels" ), formatter: p => fmt( p.value[ 1 ] ), fontSize: 9 } };
        } );
        option.visualMap = visualMapFor( cfg, min, max, fmt, Array.from( values.values() ).every( Number.isInteger ) );
        if ( option.tooltip ) {
            option.tooltip.trigger = "item";
            option.tooltip.formatter = p => esc( formatDate( p.value[ 0 ] ) ) + ": <b>" + esc( fmt( p.value[ 1 ] ) ) + "</b>";
        }
        // the calendars need this much room; grow the region when the Height is too small
        const needed = vertical
            ? first + rangeWeeks( ranges[ 0 ] ) * cell + 40 + ( scaleShown ? 56 : 0 )
            : first + ranges.length * block + ( scaleShown ? 56 : 8 );
        return { names: [], ctx: {}, minHeight: needed };
    }

    // a round maximum just above the largest value (for gauges and radar spokes)
    function niceMax( value ) {
        if ( !( value > 0 ) ) { return 100; }
        if ( value <= 100 && value > 10 ) { return 100; }
        const step = Math.pow( 10, Math.floor( Math.log10( value ) ) );
        return Math.ceil( value * 1.05 / step ) * step;
    }

    // one value per name, summed, in row order (gauge, funnel)
    function namedValues( rows ) {
        const map = new Map();
        rows.forEach( r => {
            const name = str( r.x ), e = map.get( name ) || { name, value: 0 };
            e.value += num( r.v ) || 0;
            if ( r.c ) { e.itemStyle = { color: r.c }; }
            map.set( name, e );
        } );
        return Array.from( map.values() );
    }

    function buildGauge( cfg, rows, option, fmt, dark, palette ) {
        const go = cfg.gaugeOptions, data = namedValues( rows ),
            min = num( cfg.yAxisMin ) === null ? 0 : num( cfg.yAxisMin ),
            max = num( cfg.yAxisMax ) === null ? niceMax( Math.max.apply( null, data.map( d => d.value ) ) ) : num( cfg.yAxisMax ),
            half = has( go, "half" ),
            rings = has( go, "rings" ),
            scale = has( go, "scale" ),
            th = titleHeight( cfg ),
            text = dark ? "#eef0f6" : "#1f2333";
        data.forEach( ( d, i ) => { if ( !d.itemStyle ) { d.itemStyle = { color: palette[ i % palette.length ] }; } } );
        const base = {
            type: "gauge",
            min,
            max,
            startAngle: half ? 180 : 225,
            endAngle: half ? 0 : -45,
            center: [ "50%", half ? "70%" : ( th ? "56%" : "52%" ) ],
            radius: half ? "100%" : "82%",
            pointer: { show: has( go, "pointer" ) && !rings, width: 5, itemStyle: { color: "auto" } },
            anchor: { show: has( go, "pointer" ) && !rings, size: 12, itemStyle: { borderWidth: 2 } },
            axisTick: { show: scale },
            splitLine: { show: scale, length: 10, distance: 4 },
            axisLabel: { show: scale, distance: 18, formatter: makeFormatter( cfg, true ) },
            title: { color: text, fontSize: 13 },
            detail: { valueAnimation: true, formatter: v => fmt( v ), fontSize: 24, fontWeight: "bold", color: text, offsetCenter: [ 0, half ? "-18%" : "62%" ] }
        };
        if ( rings ) {
            // one full-circle ring per row from the outside in; names and values go to the legend
            const n = data.length, step = Math.min( 16, 70 / Math.max( n, 1 ) );
            data.forEach( ( d, i ) => {
                option.series.push( Object.assign( {}, base, {
                    name: d.name,
                    itemStyle: { color: d.itemStyle.color },
                    startAngle: 90,
                    endAngle: -270,
                    center: [ "50%", th ? "52%" : "46%" ],
                    radius: ( 86 - i * step ) + "%",
                    progress: { show: true, roundCap: true, width: 14 },
                    axisLine: { roundCap: true, lineStyle: { width: 14, color: [ [ 1, dark ? "#2b2d36" : "#eef0f6" ] ] } },
                    title: { show: false },
                    detail: { show: false },
                    data: [ d ]
                } ) );
            } );
            return { names: data.map( d => d.name ), ctx: {}, alwaysLegend: true, legendFormatter: name => {
                const d = data.find( x => x.name === name );
                return name + "  " + ( d ? fmt( d.value ) : "" );
            } };
        } else {
            const progress = has( go, "progress" );
            option.series.push( Object.assign( base, {
                name: cfg.title || prettify( cfg.valueColumn ) || "Value",
                progress: { show: progress, width: 14, roundCap: data.length === 1 },
                axisLine: { roundCap: progress && data.length === 1, lineStyle: { width: progress ? 14 : 18, color: progress ? [ [ 1, dark ? "#2b2d36" : "#eef0f6" ] ] : [ [ 0.3, "#3fbe95" ], [ 0.7, "#ffd10a" ], [ 1, "#fb628b" ] ] } },
                data: data.length === 1 ? data : data.map( ( d, i ) => Object.assign( d, {
                    title: { offsetCenter: [ ( i - ( data.length - 1 ) / 2 ) * 46 + "%", half ? "12%" : "88%" ] },
                    detail: { offsetCenter: [ ( i - ( data.length - 1 ) / 2 ) * 46 + "%", half ? "-6%" : "70%" ], fontSize: 16, color: d.itemStyle.color }
                } ) )
            } ) );
        }
        if ( option.tooltip ) {
            option.tooltip.trigger = "item";
            option.tooltip.formatter = p => esc( p.name ) + ": <b>" + esc( fmt( p.value ) ) + "</b>";
        }
        return { names: [], ctx: {} };
    }

    function buildFunnel( cfg, rows, option, fmt ) {
        const fo = cfg.funnelOptions, data = namedValues( rows ),
            first = data.length ? Math.max.apply( null, data.map( d => d.value ) ) : 0,
            th = titleHeight( cfg ), legendOn = has( cfg.features, "legend" ) && data.length > 1,
            pos = cfg.legendPosition || "bottom";
        const inside = !cfg.labelPosition || cfg.labelPosition === "inside";
        option.series.push( {
            type: "funnel",
            name: cfg.title || prettify( cfg.valueColumn ) || "Value",
            data,
            sort: has( fo, "pyramid" ) ? "ascending" : "descending",
            gap: has( fo, "gaps" ) ? 3 : 0,
            top: th + ( legendOn && pos === "top" ? 44 : 16 ),
            bottom: legendOn && pos === "bottom" ? 44 : 16,
            left: legendOn && pos === "left" ? "24%" : inside ? "10%" : "6%",
            width: inside ? ( legendOn && ( pos === "left" || pos === "right" ) ? "64%" : "80%" ) : "60%",
            minSize: "8%",
            label: {
                show: true,
                position: cfg.labelPosition || "inside",
                formatter: p => p.name + ( has( fo, "percent" ) && first ? ": " + ( p.value / first * 100 ).toFixed( 1 ) + "%" : ": " + fmt( p.value ) )
            },
            itemStyle: { borderWidth: 0 },
            emphasis: { label: { fontWeight: "bold" } }
        } );
        if ( option.tooltip ) {
            option.tooltip.trigger = "item";
            option.tooltip.formatter = p => p.marker + esc( p.name ) + ": <b>" + esc( fmt( p.value ) ) + "</b>" + ( first ? " (" + ( p.value / first * 100 ).toFixed( 1 ) + "%)" : "" );
        }
        return { names: data.map( d => d.name ), ctx: {} };
    }

    function buildRadar( cfg, rows, option, fmt ) {
        const ro = cfg.radarOptions, d = categoryData( rows, cfg ), th = titleHeight( cfg ),
            all = [], names = [];
        d.series.forEach( e => e.values.forEach( v => { if ( v !== null ) { all.push( v ); } } ) );
        const max = num( cfg.yAxisMax ) === null ? niceMax( Math.max.apply( null, all ) ) : num( cfg.yAxisMax ),
            legendOn = has( cfg.features, "legend" ) && d.series.size > 1, pos = cfg.legendPosition || "bottom";
        option.radar = {
            indicator: d.cats.map( c => ( { name: c, max } ) ),
            shape: has( ro, "circle" ) ? "circle" : "polygon",
            center: [ legendOn && pos === "left" ? "56%" : legendOn && pos === "right" ? "44%" : "50%", th ? "56%" : "52%" ],
            radius: legendOn && ( pos === "top" || pos === "bottom" ) ? "60%" : "68%",
            splitArea: { show: true }
        };
        const data = [];
        d.series.forEach( ( e, name ) => {
            names.push( name );
            data.push( { name, value: d.cats.map( c => e.values.has( c ) ? e.values.get( c ) : 0 ) } );
        } );
        option.series.push( {
            type: "radar",
            data,
            symbol: has( ro, "symbols" ) ? ( cfg.symbol || "circle" ) : "none",
            symbolSize: cfg.symbolSize || 6,
            areaStyle: has( ro, "area" ) ? { opacity: 0.18 } : undefined,
            label: { show: has( cfg.features, "labels" ), formatter: p => fmt( p.value ) },
            emphasis: { focus: "self", areaStyle: { opacity: 0.35 } }
        } );
        if ( option.tooltip ) {
            option.tooltip.trigger = "item";
            option.tooltip.formatter = p => p.marker + "<b>" + esc( p.name ) + "</b>" + d.cats.map( ( c, i ) => "<br>" + esc( c ) + ": " + esc( fmt( p.value[ i ] ) ) ).join( "" );
        }
        return { names, ctx: {} };
    }

    // links from the label (source) to the y column (target), summed per pair
    function linkData( rows ) {
        const nodes = new Map(), links = new Map();
        rows.forEach( r => {
            const s = str( r.x ), t = str( r.y ), v = num( r.v );
            if ( !s ) { return; }
            if ( !nodes.has( s ) ) { nodes.set( s, { name: s, value: 0, category: r.s } ); }
            if ( t ) {
                if ( !nodes.has( t ) ) { nodes.set( t, { name: t, value: 0 } ); }
                const key = s + "\u0001" + t, link = links.get( key ) || { source: s, target: t, value: 0 };
                link.value += v || 0;
                links.set( key, link );
                nodes.get( s ).value += v || 0;
                nodes.get( t ).value += v || 0;
            }
            if ( r.s !== undefined && r.s !== null && nodes.get( s ).category === undefined ) { nodes.get( s ).category = r.s; }
        } );
        return { nodes: Array.from( nodes.values() ), links: Array.from( links.values() ) };
    }

    function buildSankey( cfg, rows, option, fmt ) {
        const so = cfg.sankeyOptions, g = linkData( rows ), vertical = has( so, "vertical" ), th = titleHeight( cfg );
        option.series.push( {
            type: "sankey",
            data: g.nodes.map( n => ( { name: n.name } ) ),
            links: g.links.filter( l => l.source !== l.target ),
            orient: vertical ? "vertical" : "horizontal",
            nodeAlign: has( so, "alignLeft" ) ? "left" : "justify",
            top: th + ( cfg.toolbox && !cfg.title ? 40 : 16 ),
            bottom: vertical ? 40 : 16,
            left: 16,
            right: vertical ? 16 : 110,
            emphasis: { focus: "adjacency" },
            lineStyle: { color: has( so, "gradient" ) ? "gradient" : "source", curveness: 0.5, opacity: 0.35 },
            label: { position: vertical ? "bottom" : "right", formatter: p => p.name + ( has( cfg.features, "labels" ) ? " (" + fmt( p.value ) + ")" : "" ) }
        } );
        if ( option.tooltip ) {
            option.tooltip.trigger = "item";
            option.tooltip.formatter = p => p.dataType === "edge"
                ? esc( p.data.source ) + " &rarr; " + esc( p.data.target ) + ": <b>" + esc( fmt( p.value ) ) + "</b>"
                : esc( p.name ) + ": <b>" + esc( fmt( p.value ) ) + "</b>";
        }
        return { names: [], ctx: {} };
    }

    function buildSunburst( cfg, rows, option, fmt ) {
        const so = cfg.sunburstOptions, th = titleHeight( cfg ), labels = has( cfg.features, "labels" );
        option.series.push( {
            type: "sunburst",
            data: hierarchy( rows ),
            radius: [ "12%", "92%" ],
            center: [ "50%", th ? "55%" : "50%" ],
            sort: has( so, "sort" ) ? "desc" : null,
            nodeClick: has( so, "zoom" ) ? "rootToNode" : false,
            emphasis: { focus: has( so, "ancestors" ) ? "ancestor" : "self" },
            itemStyle: { borderColor: "#fff", borderWidth: 1.5 },
            label: { rotate: has( so, "radialLabels" ) ? "radial" : "tangential", minAngle: 8, formatter: p => p.name + ( labels ? "\n" + fmt( p.value ) : "" ) },
            levels: [ {}, { r0: "12%", r: "40%", label: { rotate: has( so, "radialLabels" ) ? "radial" : 0 } }, { r0: "40%", r: "70%" }, { r0: "70%", r: "74%", label: { show: false } } ]
        } );
        // without IDs every row is a ring segment of one level
        if ( !rows.some( r => r.id !== undefined && r.id !== null ) ) { option.series[ 0 ].levels = [ {}, { r0: "20%", r: "90%" } ]; }
        if ( option.tooltip ) {
            option.tooltip.trigger = "item";
            option.tooltip.formatter = p => ( p.treePathInfo || [] ).slice( 1 ).map( n => esc( n.name ) ).join( " / " ) + ": <b>" + esc( fmt( p.value ) ) + "</b>";
        }
        return { names: [], ctx: {} };
    }

    function buildGraph( cfg, rows, option, fmt ) {
        const go = cfg.graphOptions, g = linkData( rows ), th = titleHeight( cfg ),
            cats = Array.from( new Set( g.nodes.map( n => n.category ).filter( c => c !== undefined && c !== null ).map( String ) ) ),
            maxValue = Math.max.apply( null, g.nodes.map( n => n.value ).concat( [ 1 ] ) ),
            force = has( go, "force" );
        option.series.push( {
            type: "graph",
            layout: force ? "force" : "circular",
            data: g.nodes.map( n => ( {
                name: n.name,
                value: n.value,
                category: n.category === undefined || n.category === null ? undefined : cats.indexOf( String( n.category ) ),
                symbolSize: 10 + Math.sqrt( n.value / maxValue ) * ( cfg.symbolSize || 34 )
            } ) ),
            links: g.links,
            categories: cats.map( c => ( { name: c } ) ),
            roam: has( go, "roam" ),
            draggable: has( go, "draggable" ) && force,
            force: { repulsion: 220, edgeLength: [ 50, 130 ], gravity: 0.14 },
            circular: { rotateLabel: true },
            top: th + 70, bottom: 40, left: 40, right: 60,
            edgeSymbol: has( go, "arrows" ) ? [ "none", "arrow" ] : [ "none", "none" ],
            edgeSymbolSize: 8,
            lineStyle: { color: "source", curveness: force ? 0.1 : 0.3, opacity: 0.6 },
            label: { show: true, position: "right", formatter: p => p.name + ( has( cfg.features, "labels" ) ? " (" + fmt( p.value ) + ")" : "" ) },
            emphasis: { focus: "adjacency", lineStyle: { width: 3 } }
        } );
        if ( option.tooltip ) {
            option.tooltip.trigger = "item";
            option.tooltip.formatter = p => p.dataType === "edge"
                ? esc( p.data.source ) + " &rarr; " + esc( p.data.target ) + ": <b>" + esc( fmt( p.value ) ) + "</b>"
                : esc( p.name ) + ": <b>" + esc( fmt( p.value ) ) + "</b>";
        }
        return { names: cats, ctx: {} };
    }

    function buildCandlestick( cfg, rows, option, fmt ) {
        const f = cfg.features, cats = [], data = [];
        rows.forEach( r => {
            cats.push( str( r.x ) );
            data.push( [ num( r.o ), num( r.v ), num( r.l ), num( r.h ) ] );
        } );
        option.xAxis = { type: "category", data: cats, boundaryGap: true, axisLabel: { rotate: cfg.xLabelRotate || 0, hideOverlap: true } };
        option.yAxis = {
            type: "value", scale: true,
            min: axisLimit( cfg.yAxisMin ), max: axisLimit( cfg.yAxisMax ),
            splitLine: { show: true }, axisLabel: { formatter: axisFormatter( cfg ) }
        };
        if ( cfg.xAxisTitle ) { Object.assign( option.xAxis, { name: cfg.xAxisTitle, nameLocation: "middle", nameGap: 32 } ); }
        if ( cfg.yAxisTitle ) { Object.assign( option.yAxis, { name: cfg.yAxisTitle, nameLocation: "end", nameTextStyle: { align: "left" } } ); }
        // green when the close is above the open, red when below
        option.series.push( {
            type: "candlestick",
            name: cfg.title || prettify( cfg.valueColumn ) || "Price",
            data,
            itemStyle: { color: "#16a34a", color0: "#dc2626", borderColor: "#16a34a", borderColor0: "#dc2626" }
        } );
        if ( option.tooltip ) {
            option.tooltip.trigger = "axis";
            option.tooltip.axisPointer = { type: "cross" };
            option.tooltip.formatter = params => {
                const p = params[ 0 ], v = p.data.slice( -4 );
                return esc( p.axisValueLabel ) + "<br>Open: <b>" + esc( fmt( v[ 0 ] ) ) + "</b><br>Close: <b>" + esc( fmt( v[ 1 ] ) ) +
                    "</b><br>Low: <b>" + esc( fmt( v[ 2 ] ) ) + "</b><br>High: <b>" + esc( fmt( v[ 3 ] ) ) + "</b>";
            };
        }
        const zoom = [];
        if ( has( f, "zoomInside" ) ) { zoom.push( { type: "inside", xAxisIndex: 0 } ); }
        if ( has( f, "zoomSlider" ) ) { zoom.push( { type: "slider", xAxisIndex: 0, bottom: 8 } ); }
        if ( zoom.length ) { option.dataZoom = zoom; }
        return { names: [], ctx: { xTitle: !!cfg.xAxisTitle, yTitle: !!cfg.yAxisTitle, slider: has( f, "zoomSlider" ) } };
    }

    // five-number summary per category, values beyond 1.5 x IQR drawn as outliers
    function buildBoxplot( cfg, rows, option, fmt ) {
        const groups = new Map();
        rows.forEach( r => {
            const c = str( r.x ), v = num( r.v );
            if ( !groups.has( c ) ) { groups.set( c, [] ); }
            if ( v !== null ) { groups.get( c ).push( v ); }
        } );
        const cats = Array.from( groups.keys() ), boxes = [], outliers = [];
        const q = ( s, p ) => {
            const i = ( s.length - 1 ) * p, lo = Math.floor( i ), hi = Math.ceil( i );
            return s[ lo ] + ( s[ hi ] - s[ lo ] ) * ( i - lo );
        };
        cats.forEach( ( c, ci ) => {
            const s = groups.get( c ).sort( ( a, b ) => a - b );
            if ( !s.length ) { boxes.push( [] ); return; }
            const q1 = q( s, 0.25 ), q2 = q( s, 0.5 ), q3 = q( s, 0.75 ), iqr = q3 - q1,
                inside = s.filter( v => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr );
            boxes.push( [ inside[ 0 ], q1, q2, q3, inside[ inside.length - 1 ] ] );
            s.filter( v => inside.indexOf( v ) < 0 ).forEach( v => outliers.push( [ ci, v ] ) );
        } );
        option.xAxis = { type: "category", data: cats, boundaryGap: true, axisLabel: { rotate: cfg.xLabelRotate || 0, hideOverlap: true } };
        option.yAxis = { type: "value", scale: true, min: axisLimit( cfg.yAxisMin ), max: axisLimit( cfg.yAxisMax ), axisLabel: { formatter: axisFormatter( cfg ) } };
        if ( cfg.xAxisTitle ) { Object.assign( option.xAxis, { name: cfg.xAxisTitle, nameLocation: "middle", nameGap: 32 } ); }
        if ( cfg.yAxisTitle ) { Object.assign( option.yAxis, { name: cfg.yAxisTitle, nameLocation: "end", nameTextStyle: { align: "left" } } ); }
        option.series.push( { type: "boxplot", name: prettify( cfg.valueColumn ) || "Value", data: boxes, itemStyle: { borderWidth: 1.5 } } );
        if ( outliers.length ) { option.series.push( { type: "scatter", name: "Outliers", data: outliers, symbolSize: 7 } ); }
        if ( option.tooltip ) {
            option.tooltip.trigger = "item";
            option.tooltip.formatter = p => p.seriesType === "boxplot"
                ? esc( p.name ) + [ "Minimum", "Lower quartile", "Median", "Upper quartile", "Maximum" ].map( ( l, i ) => "<br>" + l + ": <b>" + esc( fmt( p.value[ i + 1 ] ) ) + "</b>" ).join( "" )
                : esc( cats[ p.value[ 0 ] ] ) + " outlier: <b>" + esc( fmt( p.value[ 1 ] ) ) + "</b>";
        }
        return { names: [], ctx: { xTitle: !!cfg.xAxisTitle, yTitle: !!cfg.yAxisTitle } };
    }

    // ---------- option ----------
    function build( state ) {
        const cfg = state.cfg, rows = state.rows, f = cfg.features, type = cfg.chartType || "bar",
            fmt = makeFormatter( cfg ),
            palette = cfg.colors ? cfg.colors.split( "," ).map( c => c.trim() ).filter( Boolean ) : DEFAULT_PALETTE,
            option = {
                backgroundColor: "transparent",
                animation: has( f, "animation" ),
                aria: { enabled: true, decal: { show: has( f, "decal" ) } },
                series: []
            };
        let result;

        if ( cfg.colors ) { option.color = palette; }
        if ( cfg.title ) { option.title = { text: cfg.title, subtext: cfg.subtitle || "", left: cfg.titleAlign || "left" }; }

        if ( !rows.length ) {
            option.title = [ option.title || { show: false }, {
                text: state.noDataFound || "No data found.",
                left: "center",
                top: "middle",
                textStyle: { fontSize: 14, fontWeight: "normal", color: state.dark ? "#a9adbd" : "#6b7080" }
            } ];
            return option;
        }
        if ( has( f, "tooltip" ) ) { option.tooltip = { confine: true, valueFormatter: fmt }; }
        option.toolbox = toolboxFor( cfg, type );

        switch ( type ) {
            case "line":
            case "bar": result = buildAxisChart( cfg, rows, option, fmt, type, palette ); break;
            case "scatter": result = buildScatter( cfg, rows, option, fmt ); break;
            case "pie": result = buildPie( cfg, rows, option, fmt, state.dark ); break;
            case "heatmap": result = buildHeatmap( cfg, rows, option, fmt ); break;
            case "tree": result = buildTree( cfg, rows, option, fmt ); break;
            case "treemap": result = buildTreemap( cfg, rows, option, fmt, state.dark ); break;
            case "calendar": result = buildCalendar( cfg, rows, option, fmt, state.dark, state.el ); break;
            case "gauge": result = buildGauge( cfg, rows, option, fmt, state.dark, palette ); break;
            case "funnel": result = buildFunnel( cfg, rows, option, fmt ); break;
            case "radar": result = buildRadar( cfg, rows, option, fmt ); break;
            case "sankey": result = buildSankey( cfg, rows, option, fmt ); break;
            case "sunburst": result = buildSunburst( cfg, rows, option, fmt ); break;
            case "graph": result = buildGraph( cfg, rows, option, fmt ); break;
            case "candlestick": result = buildCandlestick( cfg, rows, option, fmt ); break;
            case "boxplot": result = buildBoxplot( cfg, rows, option, fmt ); break;
            default: result = { names: [], ctx: {} };
        }
        state.lookup = result;

        // gauge rings always list their names and values in the legend
        const legendOn = ( has( f, "legend" ) && [ "line", "bar", "pie", "scatter", "funnel", "radar", "graph" ].indexOf( type ) > -1 &&
            ( result.names.length > 1 || result.alwaysLegend ) ) || !!result.legendFormatter;
        if ( legendOn ) {
            option.legend = legendFor( cfg, result.names );
            if ( result.legendFormatter ) { option.legend.formatter = result.legendFormatter; }
        }
        result.ctx.legend = legendOn;
        if ( option.xAxis ) { option.grid = gridFor( cfg, result.ctx ); }
        state.minHeight = result.minHeight || 0;
        return option;
    }

    // the clicked element in plain terms, for Set Item on Click and the ECharts - Click event
    function clicked( state, p ) {
        const type = state.cfg.chartType, v = p.value, info = {
            chartType: type,
            name: p.name,
            value: v,
            seriesName: p.seriesName,
            dataIndex: p.dataIndex
        };
        if ( type === "heatmap" && Array.isArray( v ) && state.lookup ) {
            info.name = info.x = state.lookup.xs[ v[ 0 ] ];
            info.y = state.lookup.ys[ v[ 1 ] ];
            info.value = v[ 2 ];
        } else if ( type === "calendar" && Array.isArray( v ) ) {
            info.name = v[ 0 ];
            info.value = v[ 1 ];
        } else if ( type === "scatter" && Array.isArray( v ) ) {
            info.name = p.seriesName;
            info.x = v[ 0 ];
            info.y = v[ 1 ];
            info.value = v[ 1 ];
        } else if ( Array.isArray( v ) ) {
            info.value = v[ 1 ];
        }
        if ( p.data && p.data.raw !== undefined ) { info.value = p.data.raw; }
        return info;
    }

    ns.echarts = {
        init: function( regionId, advanced, initFunction, customTheme ) {
            const el = document.getElementById( regionId + "_chart" ),
                dataEl = document.getElementById( regionId + "_data" );
            if ( !el || !dataEl || !echarts ) { return; }

            const payload = JSON.parse( dataEl.textContent ),
                cfg = Object.assign( { regionId }, payload.config ),
                baseHeight = cfg.height || 400,
                state = { cfg, el, rows: payload.data.rows || [], noDataFound: payload.noDataFound };

            if ( customTheme && !customThemeRegistered ) {
                echarts.registerTheme( "apex-custom", customTheme );
                customThemeRegistered = true;
            }
            let chart = null;
            // makes the chart in the theme that fits the page now; Auto charts are made again when the page's
            // light/dark mode changes (tx-themechange on <html>)
            function create() {
                if ( chart ) { chart.dispose(); }
                state.dark = cfg.theme === "dark" || ( cfg.theme === "auto" && pageIsDark( el ) );
                const theme = cfg.theme === "custom" ? ( customTheme ? "apex-custom" : null ) : state.dark ? "dark" : null;
                chart = echarts.init( el, theme, { renderer: cfg.renderer || "canvas" } );
                charts[ regionId ] = chart;
                chart.on( "click", p => {
                    if ( p.componentType !== "series" ) { return; }
                    const info = clicked( state, p );
                    if ( cfg.clickItem ) { apex.item( cfg.clickItem ).setValue( info.name === undefined ? "" : String( info.name ) ); }
                    apex.event.trigger( "#" + regionId, "tx-echarts-click", info );
                } );
            }
            create();
            if ( cfg.theme === "auto" ) {
                document.documentElement.addEventListener( "tx-themechange", () => {
                    if ( pageIsDark( el ) !== state.dark ) { create(); draw(); }
                } );
            }

            function draw() {
                let option = build( state );
                if ( state.rows.length && advanced ) { merge( option, advanced() ); }
                if ( initFunction ) {
                    const result = initFunction.call( chart, option, { chart, rows: state.rows, config: cfg, regionId } );
                    if ( result && typeof result === "object" ) { option = result; }
                }
                const height = Math.max( baseHeight, state.minHeight || 0 );
                if ( el.clientHeight !== height ) {
                    el.style.height = height + "px";
                    chart.resize();
                }
                chart.setOption( option, { notMerge: true } );
                if ( payload.data.truncated ) {
                    apex.debug.warn( "ECharts region " + regionId + ": Maximum Rows reached, the chart shows the first rows only." );
                }
            }

            // follow the region's size; calendars recompute their cell size
            let frame = null, lastWidth = el.clientWidth;
            new ResizeObserver( () => {
                if ( frame ) { return; }
                frame = requestAnimationFrame( () => {
                    frame = null;
                    chart.resize();
                    if ( cfg.chartType === "calendar" && !cfg.cellSize && Math.abs( el.clientWidth - lastWidth ) > 8 ) {
                        lastWidth = el.clientWidth;
                        draw();
                    }
                } );
            } ).observe( el );

            apex.region.create( regionId, {
                type: "TechRevXECharts",
                refresh: function() {
                    return apex.server.plugin( payload.ajaxIdentifier, { pageItems: payload.itemsToSubmit }, {
                        refreshObject: "#" + regionId,
                        loadingIndicator: el,
                        loadingIndicatorPosition: "centered"
                    } ).done( data => {
                        state.rows = data.rows || [];
                        payload.data.truncated = data.truncated;
                        draw();
                    } );
                },
                getChart: () => chart,
                widget: () => $( el )
            } );

            draw();
        },

        // echarts instance of a region
        get: regionId => charts[ regionId ]
    };
} )( apex.jQuery, apex, window.echarts );
