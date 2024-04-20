#define __LIBELF_INTERNAL__ 1
#include "libelf.h"
#include "gelf.h"

#define R_386_32 1

#ifdef EMSCRIPTEN
#include <emscripten/val.h>
#include <emscripten/bind.h>
#endif

#include <vector>
#include <string>
#include <memory>
#include <fstream>
#include <iostream>

#include <cstdio>
#include <cstring>

struct LargeNumber {
  operator unsigned long long() const {
    return ((unsigned long long)high << 32) | low;
  }

  LargeNumber operator=(unsigned long long i) {
    high = i >> 32;
    low = i & 0xFFFFFFFF;
    isUnsigned = true;
    return *this;
  }

  unsigned int high;
  unsigned int low;
  bool isUnsigned;
};

struct RodataChunk {
#ifdef EMSCRIPTEN
  RodataChunk(): data(emscripten::val::null()) {}
#endif

  LargeNumber offset;
#ifdef EMSCRIPTEN
  emscripten::val data;
#else
  std::vector<unsigned char> data;
#endif
};

struct SymbolInfo {
  unsigned int section;
  LargeNumber address;
  LargeNumber size;
  std::string name;
};

struct RelocationInfo {
  LargeNumber address;
  LargeNumber target;
};

struct ProgramInfo {
  std::string error;
  int addressSize;
  unsigned int rodataIndex;
  LargeNumber rodataStart;
  std::vector<RodataChunk> rodataChunks;
  unsigned int relRodataIndex;
  LargeNumber relRodataStart;
  std::vector<RodataChunk> relRodataChunks;
  std::vector<SymbolInfo> symbols;
  std::vector<RelocationInfo> relocations;
};

ProgramInfo process(std::string image) {
  ProgramInfo programInfo = {};

  if (elf_version(EV_CURRENT) == EV_NONE) {
    programInfo.error = "Failed to init libelf.";
    return programInfo;
  }

  Elf *elf = elf_memory(&image[0], image.size());
  if (!elf) {
    programInfo.error = "elf_begin failed. (" + std::string(elf_errmsg(-1)) + ")";
    return programInfo;
  }

  Elf_Kind elfKind = elf_kind(elf);
  if (elfKind != ELF_K_ELF) {
    programInfo.error = "Input is not an ELF object. (" + std::to_string(elfKind) + ")";
    return programInfo;
  }

  GElf_Ehdr elfHeader;
  if (gelf_getehdr(elf, &elfHeader) != &elfHeader) {
    programInfo.error = "Failed to get ELF header. (" + std::string(elf_errmsg(-1)) + ")";
    return programInfo;
  }

  switch (elfHeader.e_machine) {
    case EM_386:
      programInfo.addressSize = 4;
      break;
    case EM_X86_64:
      programInfo.addressSize = 8;
      break;
    default:
    programInfo.error = "Unsupported architecture. (" + std::to_string(elfHeader.e_machine) + ")";
    return programInfo;
  }

  size_t numberOfSections;
  if (elf_getshdrnum(elf, &numberOfSections) != 0) {
    programInfo.error = "Failed to get number of ELF sections. (" + std::string(elf_errmsg(-1)) + ")";
    return programInfo;
  }

  size_t sectionNameStringTableIndex;
  if (elf_getshdrstrndx(elf, &sectionNameStringTableIndex) != 0) {
    programInfo.error = "Failed to get ELF section names. (" + std::string(elf_errmsg(-1)) + ")";
    return programInfo;
  }

  Elf_Scn *relocationTableScn = nullptr;

  Elf_Scn *dynamicSymbolTableScn = nullptr;

  Elf_Scn *symbolTableScn = nullptr;

  size_t stringTableIndex = SHN_UNDEF;
  Elf_Scn *stringTableScn = nullptr;

  size_t rodataIndex = SHN_UNDEF;
  Elf64_Addr rodataOffset;
  Elf_Scn *rodataScn = nullptr;

  size_t relRodataIndex = SHN_UNDEF;
  Elf64_Addr relRodataOffset;
  Elf_Scn *relRodataScn = nullptr;

  for (size_t elfSectionIndex = 0; elfSectionIndex < numberOfSections; ++elfSectionIndex) {
    Elf_Scn *elfScn = elf_getscn(elf, elfSectionIndex);
    if (!elfScn) {
      programInfo.error = "Failed to get section " + std::to_string(elfSectionIndex) + ". (" + std::string(elf_errmsg(-1)) + ")";
      continue;
    }

    GElf_Shdr elfSectionHeader;
    if (gelf_getshdr(elfScn, &elfSectionHeader) != &elfSectionHeader) {
      programInfo.error = "Failed to get header for section " + std::to_string(elfSectionIndex) + ". (" + std::string(elf_errmsg(-1)) + ")";
      continue;
    }

    const char *name = elf_strptr(elf, sectionNameStringTableIndex, elfSectionHeader.sh_name);
    if (!name) {
      programInfo.error = "Failed to get name of section " + std::to_string(elfSectionIndex) + ". (" + std::string(elf_errmsg(-1)) + ")";
      continue;
    }

    if (elfSectionHeader.sh_type == SHT_REL && strcmp(name, ".rel.dyn") == 0) {
      relocationTableScn = elfScn;
    } else if (elfSectionHeader.sh_type == SHT_DYNSYM && strcmp(name, ".dynsym") == 0) {
      dynamicSymbolTableScn = elfScn;
    } else if (elfSectionHeader.sh_type == SHT_SYMTAB && strcmp(name, ".symtab") == 0) {
      symbolTableScn = elfScn;
    } else if (elfSectionHeader.sh_type == SHT_STRTAB && strcmp(name, ".strtab") == 0) {
      stringTableIndex = elfSectionIndex;
      stringTableScn = elfScn;
    } else if (elfSectionHeader.sh_type == SHT_PROGBITS && strcmp(name, ".rodata") == 0) {
      rodataIndex = elfSectionIndex;
      rodataOffset = elfSectionHeader.sh_addr;
      rodataScn = elfScn;
    } else if (elfSectionHeader.sh_type == SHT_PROGBITS && strcmp(name, ".data.rel.ro") == 0) {
      relRodataIndex = elfSectionIndex;
      relRodataOffset = elfSectionHeader.sh_addr;
      relRodataScn = elfScn;
    }

    if (relocationTableScn && dynamicSymbolTableScn && symbolTableScn && stringTableScn && rodataScn && relRodataScn) {
      break;
    }
  }

  if (!symbolTableScn || !stringTableScn || !rodataScn) {
    programInfo.error = "Failed to find all required ELF sections.";
    return programInfo;
  }

  programInfo.rodataStart = rodataOffset;
  programInfo.rodataIndex = rodataIndex;

  if (relocationTableScn && dynamicSymbolTableScn) {
    Elf_Data *relocationData = nullptr;
    while ((relocationData = elf_getdata(relocationTableScn, relocationData)) != nullptr) {
      size_t relocationIndex = 0;
      GElf_Rel relocation;
      while (gelf_getrel(relocationData, relocationIndex++, &relocation) == &relocation) {
        size_t type = GELF_R_TYPE(relocation.r_info);
        if (type != R_386_32) {
          continue;
        }

        Elf_Data *symbolData = nullptr;
        while ((symbolData = elf_getdata(dynamicSymbolTableScn, symbolData)) != nullptr) {
          GElf_Sym symbol;
          size_t symbolIndex = GELF_R_SYM(relocation.r_info);
          if (gelf_getsym(symbolData, symbolIndex, &symbol) != &symbol) {
            continue;
          }

          RelocationInfo relocationInfo;
          relocationInfo.address = relocation.r_offset;
          relocationInfo.target = symbol.st_value;
          programInfo.relocations.push_back(std::move(relocationInfo));

          break;
        }
      }
    }
  }

  Elf_Data *rodata = nullptr;
  while ((rodata = elf_getdata(rodataScn, rodata)) != nullptr) {
    RodataChunk rodataChunk;
    rodataChunk.offset = rodata->d_off;
#ifdef EMSCRIPTEN
    // memory_view doesn't do a copy, but we want JS to manage this once embind is done.
    rodataChunk.data = emscripten::val(emscripten::memory_view<unsigned char>(rodata->d_size, (unsigned char *)rodata->d_buf)).call<emscripten::val>("slice");
#else
    rodataChunk.data = std::move(std::vector<unsigned char>((char *)rodata->d_buf, (char *)rodata->d_buf + rodata->d_size));
#endif
    programInfo.rodataChunks.push_back(std::move(rodataChunk));
  }

  if (relRodataScn) {
    programInfo.relRodataStart = relRodataOffset;
    programInfo.relRodataIndex = relRodataIndex;

    Elf_Data *relRodata = nullptr;
    while ((relRodata = elf_getdata(relRodataScn, relRodata)) != nullptr) {
      RodataChunk relRodataChunk;
      relRodataChunk.offset = relRodata->d_off;
  #ifdef EMSCRIPTEN
      // memory_view doesn't do a copy, but we want JS to manage this once embind is done.
      relRodataChunk.data = emscripten::val(emscripten::memory_view<unsigned char>(relRodata->d_size, (unsigned char *)relRodata->d_buf)).call<emscripten::val>("slice");
  #else
      relRodataChunk.data = std::move(std::vector<unsigned char>((char *)relRodata->d_buf, (char *)relRodata->d_buf + relRodata->d_size));
  #endif
      programInfo.relRodataChunks.push_back(std::move(relRodataChunk));
    }
  }

  Elf_Data *symbolData = nullptr;
  while ((symbolData = elf_getdata(symbolTableScn, symbolData)) != nullptr) {
    size_t symbolIndex = 0;
    GElf_Sym symbol;
    while (gelf_getsym(symbolData, symbolIndex++, &symbol) == &symbol) {
      const char *name = elf_strptr(elf, stringTableIndex, symbol.st_name);
      if (!name) {
        std::cerr << "Failed to symbol name for " + std::to_string(symbolIndex) + ". (" + std::string(elf_errmsg(-1)) + ")" << std::endl;
        continue;
      }

      SymbolInfo symbolInfo;
      symbolInfo.section = symbol.st_shndx;
      symbolInfo.address = symbol.st_value;
      symbolInfo.size = symbol.st_size;
      symbolInfo.name = name;
      programInfo.symbols.push_back(std::move(symbolInfo));
    }
  }

  elf_end(elf);
  return programInfo;
}

#ifdef EMSCRIPTEN
EMSCRIPTEN_BINDINGS(vtable) {
  emscripten::value_object<LargeNumber>("LargeNumber")
    .field("high", &LargeNumber::high)
    .field("low", &LargeNumber::low)
    .field("unsigned", &LargeNumber::isUnsigned);

  emscripten::value_object<ProgramInfo>("ProgramInfo")
    .field("error", &ProgramInfo::error)
    .field("addressSize", &ProgramInfo::addressSize)
    .field("rodataStart", &ProgramInfo::rodataStart)
    .field("rodataIndex", &ProgramInfo::rodataIndex)
    .field("rodataChunks", &ProgramInfo::rodataChunks)
    .field("relRodataStart", &ProgramInfo::relRodataStart)
    .field("relRodataIndex", &ProgramInfo::relRodataIndex)
    .field("relRodataChunks", &ProgramInfo::relRodataChunks)
    .field("symbols", &ProgramInfo::symbols)
    .field("relocations", &ProgramInfo::relocations);

  emscripten::value_object<RodataChunk>("RodataChunk")
    .field("offset", &RodataChunk::offset)
    .field("data", &RodataChunk::data);

  emscripten::value_object<SymbolInfo>("SymbolInfo")
    .field("section", &SymbolInfo::section)
    .field("address", &SymbolInfo::address)
    .field("size", &SymbolInfo::size)
    .field("name", &SymbolInfo::name);

  emscripten::value_object<RelocationInfo>("RelocationInfo")
    .field("address", &RelocationInfo::address)
    .field("target", &RelocationInfo::target);

  emscripten::register_vector<RodataChunk>("VectorRodataChunk");
  emscripten::register_vector<SymbolInfo>("VectorSymbolInfo");
  emscripten::register_vector<RelocationInfo>("VectorRelocationInfo");

  emscripten::function("process", &process);
}
#else
int main(int argc, char *argv[]) {
  if (argc < 2) {
    fprintf(stderr, "Usage: %s <file-name>\n", argv[0]);
    return 1;
  }

  std::ifstream file(argv[1], std::ios::binary);
  std::string image((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());

  ProgramInfo programInfo = process(image);

  if (!programInfo.error.empty()) {
    fprintf(stderr, "Failed to process input file '%s': %s.\n", argv[1], programInfo.error.c_str());
    return 1;
  }

  fprintf(stdout, "address size: %d\n", programInfo.addressSize);
  fprintf(stdout, "rodata start: %08llx\n", (unsigned long long)programInfo.rodataStart);
  fprintf(stdout, "rodata chunks: %u\n", programInfo.rodataChunks.size());
  for (const auto &chunk : programInfo.rodataChunks) {
    fprintf(stdout, "  offset: %08llx\n", (unsigned long long)chunk.offset);
    fprintf(stdout, "    size: %u\n", chunk.data.size());
  }

  fprintf(stdout, "symbols: %u\n", programInfo.symbols.size());
  for (const auto &symbol : programInfo.symbols) {
    if (symbol.address == 0 || symbol.size == 0 || symbol.name.empty()) {
      continue;
    }
    fprintf(stdout, "  offset: %08llx\n", (unsigned long long)symbol.address);
    fprintf(stdout, "    size: %llu\n", (unsigned long long)symbol.size);
    fprintf(stdout, "    name: %s\n", symbol.name.c_str());
  }

  return 0;
}
#endif
