cmake_minimum_required(VERSION 3.24)
project(exrview_native C CXX)

# OpenEXR is fetched and built as a static library. We only use OpenEXRCore
# (the C API), but OpenEXR's build configures the whole project.
include(FetchContent)

set(OPENEXR_VERSION_TAG v3.5.2 CACHE STRING "OpenEXR git tag" FORCE)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(OPENEXR_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(OPENEXR_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(OPENEXR_INSTALL OFF CACHE BOOL "" FORCE)
set(OPENEXR_INSTALL_TOOLS OFF CACHE BOOL "" FORCE)
set(OPENEXR_INSTALL_PKG_CONFIG OFF CACHE BOOL "" FORCE)
set(OPENEXR_INSTALL_DOCS OFF CACHE BOOL "" FORCE)
set(OPENEXR_BUILD_PYTHON OFF CACHE BOOL "" FORCE)
set(OPENEXR_ENABLE_THREADING OFF CACHE BOOL "" FORCE)
set(OPENEXR_FORCE_INTERNAL_DEFLATE ON CACHE BOOL "" FORCE)
set(OPENEXR_FORCE_INTERNAL_IMATH ON CACHE BOOL "" FORCE)

FetchContent_Declare(openexr
  GIT_REPOSITORY https://github.com/AcademySoftwareFoundation/openexr.git
  GIT_TAG        ${OPENEXR_VERSION_TAG}
  GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(openexr)

add_library(exrview STATIC src/exrview.c)
target_include_directories(exrview PUBLIC src)
target_link_libraries(exrview PUBLIC OpenEXR::OpenEXRCore)
if(MSVC)
  target_compile_options(exrview PRIVATE /W4)
else()
  target_compile_options(exrview PRIVATE -Wall -Wextra)
endif()

if(EMSCRIPTEN)
  # Produces exrview.js + exrview.wasm, loaded by the webview as a global
  # factory `createExrViewModule()`.
  add_executable(exrview_wasm src/exrview.c)
  set_target_properties(exrview_wasm PROPERTIES OUTPUT_NAME exrview)
  target_include_directories(exrview_wasm PRIVATE src)
  target_link_libraries(exrview_wasm PRIVATE OpenEXR::OpenEXRCore)
  target_link_options(exrview_wasm PRIVATE
    -sMODULARIZE=1
    -sEXPORT_NAME=createExrViewModule
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1
    -sMAXIMUM_MEMORY=4GB
    -sFILESYSTEM=0
    -sEXPORTED_FUNCTIONS=_malloc,_free,_exrv_open,_exrv_close,_exrv_last_error,_exrv_header_json,_exrv_decode_channels
    -sEXPORTED_RUNTIME_METHODS=UTF8ToString,HEAPU8,HEAP32,HEAPF32
  )
else()
  add_executable(exrv_info tools/exrv_info.c)
  target_link_libraries(exrv_info PRIVATE exrview)
endif()
