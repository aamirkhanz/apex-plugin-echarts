-- Apache ECharts region plug-in (TechRevX, www.techrevx.com)
-- render: writes the chart container and a JSON block with the attribute values and the first data set,
--         then calls techrevx.echarts.init (echarts-apex.js) with the Advanced Options, the
--         Initialization JavaScript Function and the Custom Theme as JavaScript.
-- ajax:   returns the rows again for apex.region( id ).refresh().
-- Each row holds only the mapped columns: x (label), v (value), s (series), y (y category),
-- id, p (parent id), sz (size), c (color), o (open), h (high) and l (low). Dates are written as YYYY-MM-DD[ HH24:MI:SS].

-- attributes passed to the browser; keys are the static ids in lower camel case (X_AXIS_TITLE -> xAxisTitle)
c_substituted constant apex_t_varchar2 := apex_t_varchar2(
    'TITLE', 'SUBTITLE', 'X_AXIS_TITLE', 'Y_AXIS_TITLE', 'VALUE_SUFFIX', 'Y_AXIS_MIN', 'Y_AXIS_MAX',
    'COLORS', 'BAR_WIDTH', 'PIE_RADIUS', 'CALENDAR_RANGE' );
c_plain constant apex_t_varchar2 := apex_t_varchar2(
    'CHART_TYPE', 'TITLE_ALIGN', 'THEME', 'RENDERER', 'X_COLUMN', 'VALUE_COLUMN', 'SERIES_COLUMN', 'Y_COLUMN',
    'ID_COLUMN', 'PARENT_COLUMN', 'SIZE_COLUMN', 'COLOR_COLUMN', 'FEATURES', 'LEGEND_POSITION', 'LEGEND_TYPE',
    'TOOLBOX', 'LABEL_POSITION', 'VALUE_FORMAT', 'CLICK_ITEM', 'AXIS_OPTIONS', 'LINE_OPTIONS', 'BAR_OPTIONS',
    'PIE_OPTIONS', 'SCATTER_OPTIONS', 'SYMBOL', 'TREE_LAYOUT', 'TREE_OPTIONS', 'TREEMAP_OPTIONS',
    'CALENDAR_OPTIONS', 'SCALE_OPTIONS', 'MIN_COLOR', 'MAX_COLOR', 'OPEN_COLUMN', 'HIGH_COLUMN', 'LOW_COLUMN',
    'GAUGE_OPTIONS', 'FUNNEL_OPTIONS', 'RADAR_OPTIONS', 'SANKEY_OPTIONS', 'SUNBURST_OPTIONS', 'GRAPH_OPTIONS' );
c_numbers constant apex_t_varchar2 := apex_t_varchar2(
    'HEIGHT', 'X_LABEL_ROTATE', 'SYMBOL_SIZE', 'TREE_DEPTH', 'TREEMAP_DEPTH', 'CELL_SIZE' );

-- data columns and their keys in each row
c_column_attrs constant apex_t_varchar2 := apex_t_varchar2(
    'X_COLUMN', 'VALUE_COLUMN', 'SERIES_COLUMN', 'Y_COLUMN', 'ID_COLUMN', 'PARENT_COLUMN', 'SIZE_COLUMN', 'COLOR_COLUMN',
    'OPEN_COLUMN', 'HIGH_COLUMN', 'LOW_COLUMN' );
c_column_keys constant apex_t_varchar2 := apex_t_varchar2( 'x', 'v', 's', 'y', 'id', 'p', 'sz', 'c', 'o', 'h', 'l' );

function json_key( p_static_id in varchar2 ) return varchar2 is
    l_key varchar2(100) := replace( initcap( p_static_id ), '_' );
begin
    return lower( substr( l_key, 1, 1 ) ) || substr( l_key, 2 );
end json_key;

function date_text( p_date in date ) return varchar2 is
begin
    return case
               when p_date = trunc( p_date ) then to_char( p_date, 'YYYY-MM-DD' )
               else to_char( p_date, 'YYYY-MM-DD HH24:MI:SS' )
           end;
end date_text;

-- writes "rows" (and "truncated" when Maximum Rows was reached) to the current apex_json output
procedure write_rows( p_region in apex_plugin.t_region ) is
    l_names   apex_t_varchar2 := apex_t_varchar2();
    l_pos     apex_t_number   := apex_t_number();
    l_types   apex_t_number   := apex_t_number();
    l_columns apex_exec.t_columns;
    l_context apex_exec.t_context;
    l_max     number := nvl( p_region.attributes.get_number( 'MAX_ROWS' ), 10000 );
    l_count   pls_integer := 0;
    l_added   boolean;
begin
    l_names.extend( c_column_attrs.count );
    l_pos.extend( c_column_attrs.count );
    l_types.extend( c_column_attrs.count );

    for i in 1 .. c_column_attrs.count loop
        l_names( i ) := p_region.attributes.get_varchar2( c_column_attrs( i ) );
        if l_names( i ) is not null then
            -- the same column may be mapped twice (for example label and ID); select it once
            l_added := false;
            for j in 1 .. i - 1 loop
                l_added := l_added or nvl( l_names( j ) = l_names( i ), false );
            end loop;
            if not l_added then
                apex_exec.add_column( p_columns => l_columns, p_column_name => l_names( i ) );
            end if;
        end if;
    end loop;

    l_context := apex_exec.open_query_context(
                     p_columns  => l_columns,
                     p_max_rows => l_max );

    for i in 1 .. c_column_attrs.count loop
        if l_names( i ) is not null then
            l_pos( i ) := apex_exec.get_column_position( l_context, l_names( i ) );
            if l_pos( i ) is null then
                raise_application_error( -20001, 'Apache ECharts: column ' || l_names( i ) || ' (' || initcap( replace( c_column_attrs( i ), '_', ' ' ) )
                                                 || ') is not in the region source of "' || p_region.name || '".' );
            end if;
            l_types( i ) := apex_exec.get_column( l_context, l_pos( i ) ).data_type;
        end if;
    end loop;

    apex_json.open_array( 'rows' );
    while apex_exec.next_row( l_context ) loop
        l_count := l_count + 1;
        apex_json.open_object;
        for i in 1 .. c_column_attrs.count loop
            if l_pos( i ) is not null then
                case
                    when l_types( i ) = apex_exec.c_data_type_number then
                        apex_json.write( c_column_keys( i ), apex_exec.get_number( l_context, l_pos( i ) ) );
                    when l_types( i ) = apex_exec.c_data_type_date then
                        apex_json.write( c_column_keys( i ), date_text( apex_exec.get_date( l_context, l_pos( i ) ) ) );
                    when l_types( i ) in ( apex_exec.c_data_type_timestamp, apex_exec.c_data_type_timestamp_tz,
                                           apex_exec.c_data_type_timestamp_ltz ) then
                        apex_json.write( c_column_keys( i ), date_text( cast( apex_exec.get_timestamp( l_context, l_pos( i ) ) as date ) ) );
                    else
                        apex_json.write( c_column_keys( i ), apex_exec.get_varchar2( l_context, l_pos( i ) ) );
                end case;
            end if;
        end loop;
        apex_json.close_object;
    end loop;
    apex_json.close_array;
    if l_count >= l_max then
        apex_json.write( 'truncated', true );
    end if;

    apex_exec.close( l_context );
exception
    when others then
        apex_exec.close( l_context );
        raise;
end write_rows;

procedure render (
    p_plugin in            apex_plugin.t_plugin,
    p_region in            apex_plugin.t_region,
    p_param  in            apex_plugin.t_region_render_param,
    p_result in out nocopy apex_plugin.t_region_render_result )
is
    l_advanced varchar2(32767) := p_region.attributes.get_varchar2( 'ADVANCED_OPTIONS' );
    l_theme    varchar2(32767) := p_plugin.attributes.get_varchar2( 'CUSTOM_THEME' );
    l_title    varchar2(4000)  := apex_plugin_util.replace_substitutions( p_region.attributes.get_varchar2( 'TITLE' ), false );
    l_json     clob;
begin
    apex_json.initialize_clob_output;
    apex_json.open_object;
    apex_json.write( 'ajaxIdentifier', apex_plugin.get_ajax_identifier );
    apex_json.write( 'itemsToSubmit', apex_plugin_util.page_item_names_to_jquery( p_region.ajax_items_to_submit ) );
    apex_json.write( 'noDataFound', apex_plugin_util.replace_substitutions( p_region.no_data_found_message, false ) );
    apex_json.open_object( 'config' );
    for i in 1 .. c_substituted.count loop
        apex_json.write( json_key( c_substituted( i ) ),
                         apex_plugin_util.replace_substitutions( p_region.attributes.get_varchar2( c_substituted( i ) ), false ) );
    end loop;
    for i in 1 .. c_plain.count loop
        apex_json.write( json_key( c_plain( i ) ), p_region.attributes.get_varchar2( c_plain( i ) ) );
    end loop;
    for i in 1 .. c_numbers.count loop
        apex_json.write( json_key( c_numbers( i ) ), p_region.attributes.get_number( c_numbers( i ) ) );
    end loop;
    apex_json.close_object;
    apex_json.open_object( 'data' );
    write_rows( p_region );
    apex_json.close_object;
    apex_json.close_object;
    l_json := apex_json.get_clob_output;
    apex_json.free_output;

    sys.htp.p( '<div id="' || apex_escape.html_attribute( p_region.static_id ) || '_chart" class="tx-ECharts" style="height:'
               || nvl( p_region.attributes.get_number( 'HEIGHT' ), 400 ) || 'px" role="img" aria-label="'
               || apex_escape.html_attribute( nvl( l_title, p_region.name ) ) || '"></div>' );
    -- JSON inside a script element: only "</" could end it early
    sys.htp.p( '<script type="application/json" id="' || apex_escape.html_attribute( p_region.static_id ) || '_data">' );
    apex_util.prn( p_clob => replace( l_json, '</', '<\/' ), p_escape => false );
    sys.htp.p( '</script>' );
    dbms_lob.freetemporary( l_json );

    apex_javascript.add_onload_code(
        p_code => 'techrevx.echarts.init(' || apex_javascript.add_value( p_region.static_id, false )
                  || ',' || case when l_advanced is not null
                                 then 'function(){return(' || chr(10) || l_advanced || chr(10) || ');}'
                                 else 'null'
                            end
                  || ',' || nvl( p_region.init_javascript_code, 'null' )
                  || ',' || case when l_theme is not null then '(' || chr(10) || l_theme || chr(10) || ')' else 'null' end
                  || ');' );
end render;

procedure ajax (
    p_plugin in            apex_plugin.t_plugin,
    p_region in            apex_plugin.t_region,
    p_param  in            apex_plugin.t_region_ajax_param,
    p_result in out nocopy apex_plugin.t_region_ajax_result )
is
begin
    apex_json.open_object;
    write_rows( p_region );
    apex_json.close_object;
end ajax;
